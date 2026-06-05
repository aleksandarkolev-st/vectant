# GPU HMR Full Runtime Correctness Plan

## Purpose

This plan defines what must be true before Synthi can claim GPU HMR full runtime render correctness for large, real renderer projects such as HIPRT-Path-Tracer.

The goal is deliberately stricter than "the device artifact compiled" or "the runtime accepted a sidecar reload." A senior GPU engineer should be able to trust the reported state without reading logs to discover hidden fallbacks, fake launch paths, stale screenshots, or session-crossed dispatch evidence.

The system must be hostile to fake success.

The source of truth for correctness must be a structured proof artifact. Logs, screenshots, changed hashes, and terminal labels are supporting evidence only. They may help diagnose a run, but they must not be the authoritative proof state.

## Current Baseline

The current system can prove several important lower-level facts:

- It can target a large real ROCm project through CodeIntel/RAG projection.
- It can split or preserve source-backed device roles.
- It can materialize partial source-include artifacts.
- It can compile a selected partial artifact.
- It can inspect exported symbols from the compiled artifact.
- It can reload a sidecar artifact into the runner.
- It can report runtime ownership for touched symbols.
- It can avoid unsafe generated launches by rejecting synthetic/null-populated source launch aggregates.
- It can scope real ROCm validation evidence to the current workspace session.

For the latest HIPRT validation, the system proved:

- `Megakernel.h` body-only edit was accepted by the deterministic device fast path.
- Selected artifact kind was `source_include_bridge`.
- Selected symbol was `MegaKernel`.
- Compiled artifact exported `MegaKernel`.
- Runtime reload touched `MegaKernel`.
- `fallbackUsed=false`.
- Full-device fallback was not used on the HMR path.

As of 2026-06-04, the HIPRT path also has accepted profiled runtime proofs for the `hiprt-megakernel-direct-light-zero` edit contract:

- Proof id: `hiprt-warm-runtime-proof:sha256:fa2e5f31bb518b9c31aacbff6baa7bbbafb23db7099a2c21b837e528e0e76dd0`.
- Proof artifact: `mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260604205609-proof.json`.
- Mode: `same-process`.
- Runtime adapter target: profile-provided HIPRT `Megakernel (1 SPP)` / `MegaKernel`.
- Live in-process recompile time: `99 ms`.
- Same-process trigger wait: `476 ms`.
- Adapter rebuild time for this run: `12478 ms`.
- Total proof wall time: `18846 ms`.
- Runtime/reload waits: unbounded unless explicitly configured.
- Visual evidence:
  - baseline: `hiprt-warm-light-math-20260604205609-same-process-baseline-framebuffer.png`,
  - changed: `hiprt-warm-light-math-20260604205609-same-process-changed-framebuffer.png`,
  - amplified diff: `hiprt-warm-light-math-20260604205609-diff-amplified.png`.
- Visual delta:
  - changed pixel ratio: `0.41822916666666665`,
  - mean absolute delta: `32.94620804398148`,
  - max channel delta: `255`.

This proves that the HIPRT original runtime can remain in the same process, observe the edited source, recompile `MegaKernel`, launch the changed function pointer, and produce a fresh ray-traced framebuffer whose lighting changes match the edit contract.

The target progression also includes an accepted smaller non-`MegaKernel` proof:

- Proof id: `hiprt-warm-runtime-proof:sha256:ef5319c4d84284d5ae7a9b2890c18eb565398086e2245d0b602de1c5d9730903`.
- Proof artifact: `mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260604211945-proof.json`.
- Profile: `hiprt-camera-rays-horizontal-mirror`.
- Runtime adapter target: profile-provided HIPRT `Fill G-Buffer` / `CameraRays`.
- Live in-process recompile time: `2377 ms`.
- Same-process trigger wait: `570 ms`.
- Adapter rebuild time for this run: `17975 ms`.
- Total proof wall time: `27535 ms`.
- Runtime/reload waits: unbounded unless explicitly configured.
- Visual evidence:
  - baseline: `hiprt-warm-light-math-20260604211945-same-process-baseline-framebuffer.png`,
  - changed: `hiprt-warm-light-math-20260604211945-same-process-changed-framebuffer.png`,
  - amplified diff: `hiprt-warm-light-math-20260604211945-diff-amplified.png`.
- Visual delta:
  - changed pixel ratio: `0.9140190972222222`,
  - mean absolute delta: `53.12725983796296`,
  - max channel delta: `255`.

This does not mean every HIPRT edit or every large renderer is now `gpu-hmr-full-runtime-proven`. The accepted proof is profile-scoped. Broader use still requires per-profile source anchors, required kernel lists, ABI/provenance gates, epoch evidence, and deterministic output-oracle coverage.

The latest strict real-ROCm CI-grade validator run now reaches full runtime proof for `ROCm/rocm-examples` `HIP-Basic/saxpy` using a source-derived output oracle:

- Run slug: `gpu-real-rocm-rocm-examples-20260604201734`.
- Model: `gemini-3.5-flash`.
- Wall time: `179400 ms`.
- Proof artifact: `mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-rocm-examples-20260604201734-real-rocm-runtime-proof-ea6dcd00060e83264d30fa1923b006275ccd495f7577e8cfefee690d3171428a.json`.
- Runtime proof layers passed: ABI, fission, RAM artifact transport, epoch graph, dispatch safety, host preservation, original-host-path attachment, and output oracle.
- Output oracle: `oracle:real-rocm:saxpy-readback-y:e92cf383c60e2a0d`.
- Output checksum expected and actual: `sha256:3b3c4853a738312b322b2aae8ec8d35fb063dc97a68f68f19932b208fe44817a`.
- Full proof state: `gpu-hmr-full-runtime-proven`.
- Visual evidence is not required for this non-render saxpy target; the HIPRT render profiles above provide the mandatory visual proof path for renderer workflows.

The latest strict HIPRT validator attempt also produced accepted native runtime framebuffer evidence through the HIPRT runtime bridge:

- Run slug: `gpu-real-rocm-HIPRT-Path-Tracer-20260604203706`.
- Visual artifact: `mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-HIPRT-Path-Tracer-20260604203706-hiprt-runtime-framebuffer.png`.
- Content hash: `sha256:7a301a69f59388fa074013e03a6f74738a426dd3d160f46aec5d5944422e9776`.
- Visual quality: `gpu-hmr-visual-varied-frame`.
- Accepted visual evidence: true.

That strict HIPRT command did not complete cleanly because the normal MCP sidecar HMR acknowledgement timed out in `real_repo_user_source_delta_hmr`. The same-process HIPRT proof commands are therefore the current accepted HIPRT runtime-visual proof path; the normal sidecar acknowledgement path still needs integration work before the whole HIPRT command surface can be called production-grade.

The current runtime replacement model is also still too stall-heavy for the desired production architecture. It can load a standby module, promote it, and unload retired modules, but the safe path is still organized around synchronization before replacement. The target architecture must move toward generation-published capsules: old code remains live for in-flight work, new launches use the new generation, and retirement happens only after stream fences prove the old generation is no longer reachable.

## Non-Negotiable Production Rule

For complex renderers, generated cores must not reconstruct launch state from static source/build metadata and then claim full runtime correctness.

Static source/build metadata is useful for indexing, selection, rejection, and ABI comparison. It is not sufficient to recreate live renderer state. It can miss:

- dynamic scene state,
- runtime camera changes,
- material uploads,
- allocator state,
- acceleration structure handles,
- stream/event ordering,
- Orochi/HIPRT initialization side effects,
- GUI-driven render settings,
- accumulation state,
- device pointer ownership,
- texture/surface object lifetime,
- graph capture state,
- persistent buffer aliases.

Default production behavior for complex renderers must be:

1. Preserve the original host launch path.
2. Attach HMR to the live launch path.
3. Replace only the selected verifier-safe device artifact.
4. Prove host/runtime state was preserved.
5. Prove the edited kernel was dispatched by the current runtime session.
6. Prove output correctness with deterministic readback or an explicitly declared weaker proof state.

Generated launch state is allowed only when the state was captured from the real runtime with verified provenance. Value-initialized aggregates, null placeholders, guessed dimensions, guessed device pointers, and generated temporaries must block full correctness.

## Proof Ladder

The result state must be a ladder. A higher state implies all lower states passed.

### `gpu-hmr-compile-proven`

The selected device artifact compiled successfully for the requested GPU vendor/arch.

Required evidence:

- compiler executable identity,
- compiler version,
- HIP/ROCm or CUDA toolkit version,
- target triple or equivalent,
- GPU vendor,
- GPU arch list,
- selected compile command hash,
- effective compiler flags,
- dependency hash,
- artifact path,
- artifact bytes,
- compile timing,
- stderr/diagnostic summary,
- cache hit/miss state.

This state does not imply runtime binding or execution.

### `gpu-hmr-symbol-bound`

The compiled artifact exports the expected symbols and the runtime can bind them.

Required evidence:

- expected source symbols,
- exported/demangled symbols where available,
- mangled/exported names where available,
- symbol ownership report,
- unknown exported symbols rejected or marked as safe superset with evidence,
- artifact kind,
- artifact filename,
- generated path,
- source path,
- mapping confidence,
- selected symbol set,
- safe superset reason when applicable.

This state does not imply ABI compatibility or dispatch.

### `gpu-hmr-abi-proven`

The replacement is ABI-compatible with the live host/runtime path.

Required evidence:

- kernel name,
- mangled/exported symbol,
- parameter count,
- parameter type identities where available,
- parameter sizes,
- parameter alignments,
- pointer address-space classification,
- struct/class layout hash for all parameter-visible layouts,
- constant memory symbol list and layout hash,
- device global symbol list and layout hash,
- texture/surface binding list,
- launch bounds,
- required dynamic shared memory policy,
- compiler flags hash,
- target ISA/arch,
- device library linkage identity,
- source include root hash,
- dependency hash,
- artifact schema version.

Signature hash alone is not enough. A struct layout change, constant layout change, device global change, address-space change, or changed texture/surface binding usually invalidates hot replacement unless the host side is rebuilt or unchanged layout is proven.

This state does not imply the kernel actually ran.

### `gpu-hmr-epoch-swap-proven`

The replacement artifact was published through a generation-aware dispatch capsule without requiring a full pre-swap synchronization of unrelated work.

This stage proves safe replacement publication and old-generation lifetime management. It is stronger and more truthful than "synchronize the whole context, swap, unload" because it records which generation each dispatch can use and keeps old code alive until in-flight streams pass an epoch fence.

Required evidence:

- old generation id,
- new generation id,
- old artifact id,
- new artifact id,
- publish timestamp,
- dispatch table hash before publish,
- dispatch table hash after publish,
- changed dispatch entries,
- ABI membrane proof id,
- exported symbol set for the new capsule,
- dependency closure hash for the new capsule,
- function handle ids for changed entries,
- stream ids using the old generation at publish time,
- retirement fence ids,
- old generation retired status,
- old generation retirement timestamp when retired,
- delayed-unload result,
- degraded reason if old generation is still pending retirement.

Required stage payload shape:

```json
{
  "oldGeneration": 17,
  "newGeneration": 18,
  "oldArtifactId": "artifact:...",
  "newArtifactId": "artifact:...",
  "publishTimestamp": "2026-05-26T00:00:00Z",
  "dispatchTableHashBefore": "sha256:...",
  "dispatchTableHashAfter": "sha256:...",
  "streamsUsingOldGeneration": ["stream:..."],
  "retirementFenceIds": ["event:..."],
  "oldGenerationRetired": true
}
```

This state does not imply the new kernel has been dispatched. It also does not prove argument provenance or output correctness.

### `gpu-hmr-dispatch-observed`

The current runtime session observed a launch of the expected kernel after the replacement.

Required evidence:

- workspace/session slug,
- runtime session id from structured runtime state,
- dispatch observation timestamp,
- kernel name,
- artifact version used by dispatch,
- stream id or stream identity,
- grid dimensions,
- block dimensions,
- shared memory bytes,
- dispatcher registration id,
- dispatcher lookup result,
- dispatch result,
- no dispatch failure lines in current session,
- no stale dispatch evidence from another session,
- runtime touched-symbol report matches selected artifact.

This state does not imply the launch was safe. A kernel dispatch can be observed while argument provenance, stream ordering, ABI, or replacement scope remains unsafe.

### `gpu-hmr-dispatch-safe-proven`

The current runtime session observed the expected dispatch and proved the dispatch was safe to count as runtime HMR evidence.

Required evidence:

- all `gpu-hmr-dispatch-observed` evidence,
- ABI proof id for the dispatched artifact,
- argument provenance proof id,
- stream ordering proof id,
- replacement scope proof id,
- current dispatcher generation,
- selected artifact id,
- runtime artifact id used by dispatch,
- no unknown/generated/null-live-object argument where source semantics require live state,
- no stale launch pointer,
- no dispatch failure for the selected kernel in the current session.

This state does not imply output correctness.

### `gpu-hmr-output-oracle-proven`

The HMR edit changed or preserved output according to an explicit deterministic oracle.

Required evidence depends on the project class:

- edit contract id,
- oracle kind,
- oracle expected value,
- oracle actual value,
- oracle pass/fail status,
- render target hash,
- accumulation buffer hash,
- sentinel buffer value,
- dispatch counter,
- selected pixel values with tolerance,
- kernel-side checksum,
- output timestamp after HMR,
- deterministic probe settings,
- expected before/after values,
- tolerance policy for floating point output.

For floating point renderers, use tolerant comparison unless the pipeline is proven bit-stable.

Screenshots and visible output are mandatory supporting evidence for render workflows. They prove that a fresh visual frame exists, but they are not enough for this state without an oracle such as a sentinel value, checksum, selected pixel expectation, or edit contract.

### `gpu-hmr-host-preservation-proven`

The host path and renderer state were preserved across HMR.

Required evidence:

- host module identity before/after,
- GUI module identity before/after,
- renderer object identity before/after,
- core state pointer before/after,
- GUI state pointer before/after,
- scene buffer identities before/after,
- persistent device allocation identities before/after,
- acceleration structure handle identities before/after where observable,
- stream identities before/after,
- no whole-runner restart unless explicitly allowed and reported as degraded,
- no host module swap unless the proof state is downgraded.

This directly prevents "device HMR" from hiding a host/core/gui restart.

### `gpu-hmr-full-runtime-proven`

All previous proof stages passed:

- compile proven,
- symbol bound,
- ABI proven,
- epoch swap proven,
- dispatch observed,
- dispatch safe proven,
- output oracle proven,
- host preservation proven.

Only this state may be described as full runtime render correctness.

## Failure And Degraded States

The system must report degraded states explicitly. It must never silently widen scope or silently count weaker evidence as full correctness.

### `gpu-hmr-fake-launch-path`

A generated host/core path tried to launch a source-backed kernel using generated or fake launch state.

Examples:

- value-initialized pointer-bearing aggregate,
- null-populated render data,
- generated temporary passed as a kernel argument,
- invented device pointer,
- invented stream,
- guessed render dimensions not tied to live state,
- source kernel launch emitted without a matching source launch graph record.

Action:

- reject full runtime correctness,
- remove or reject the fake launch,
- keep at most compile/symbol/reload proof.

### `gpu-hmr-unknown-arg-provenance`

At least one kernel argument lacks verified provenance.

Action:

- allow `gpu-hmr-dispatch-observed` if the current session really launched,
- block `gpu-hmr-dispatch-safe-proven` if the argument is used for launch,
- block `gpu-hmr-full-runtime-proven`,
- report the unknown argument index/name/type.

### `gpu-hmr-abi-unverified`

ABI compatibility evidence is missing or incomplete.

Action:

- block hot replacement unless a lower proof state is explicitly accepted,
- require host rebuild or deterministic ABI proof.

### `gpu-hmr-dispatch-unobserved`

The selected artifact was reloaded, but the current session did not dispatch the expected kernel.

Action:

- do not count runtime correctness,
- report compile/symbol/reload proof only.

### `gpu-hmr-output-unobserved`

Dispatch happened, but no deterministic output/readback proof was collected.

Action:

- stop at `gpu-hmr-dispatch-safe-proven`,
- require probe mode for full runtime correctness.

### `gpu-hmr-host-replaced`

The host/core/gui path was replaced, restarted, or state was reset while claiming device-only HMR.

Action:

- downgrade from host-preservation-proven,
- report replacement scope and reason,
- reject full runtime correctness unless the validation explicitly targeted a restart path.

### `gpu-hmr-epoch-retirement-pending`

The new generation was published, but at least one old generation is still live because stream fences have not completed.

Action:

- allow `gpu-hmr-epoch-swap-proven` only if old-generation lifetime is explicitly tracked,
- block unload of the old capsule,
- block `gpu-hmr-full-runtime-proven` until retirement completes or the validation explicitly accepts pending retirement as a lower state,
- report stream ids and fence ids still keeping the old generation alive.

### `gpu-hmr-epoch-swap-unverified`

The runtime replaced dispatch entries without structured generation lineage, dispatch table hashes, or retirement fence evidence.

Action:

- downgrade to pre-epoch replacement proof,
- block `gpu-hmr-epoch-swap-proven`,
- block `gpu-hmr-full-runtime-proven`.

### `gpu-hmr-ram-io-unavailable`

The compile/reload path requested RAM-only artifact transport, but the selected vendor/toolchain/backend could only load through a filesystem path.

Action:

- record the loader capability and fallback transport,
- allow lower proof states if the artifact hash and path are verified,
- block any claim that the run used RAM-only artifact transport,
- do not hardcode the degraded state to HIPRT, ROCm, CUDA, or any renderer.

### `gpu-hmr-visual-only`

A screenshot or visual frame exists, but no deterministic output proof exists.

Action:

- report visual evidence as supplemental,
- block `gpu-hmr-output-oracle-proven` and `gpu-hmr-full-runtime-proven`.

## Structured Proof Artifact Contract

Every validation run must produce a structured proof artifact. This artifact is the source of truth used by MCP validation, UI labels, and terminal summaries.

Logs, screenshots, visual diffs, compile output, and changed hashes must be referenced by the artifact as evidence, not parsed after the fact as proof. If a fact is only present in a log line and not in the proof artifact, it is diagnostic evidence only.

Required top-level fields:

```json
{
  "schemaVersion": "synthi.gpu.hmr.proof.v1",
  "proofId": "gpu-proof:...",
  "workspaceSlug": "hiprt-validation-...",
  "runtimeSessionId": "runtime-session:...",
  "sourceEditId": "source-edit:...",
  "selectedArtifactId": "artifact:...",
  "resultState": "gpu-hmr-dispatch-observed",
  "degradedState": "gpu-hmr-output-unobserved",
  "degradedReason": "output oracle was not collected",
  "stageResults": [],
  "evidenceRefs": [],
  "visualEvidenceRefs": [],
  "createdAt": "2026-05-26T00:00:00Z"
}
```

Required stage record fields:

- stable stage id,
- stage name,
- status,
- started and completed timestamps,
- input artifact ids,
- output artifact ids,
- evidence refs,
- degraded state and reason when not fully proven.

Required evidence ref fields:

- evidence id,
- evidence kind,
- content hash,
- producer subsystem,
- timestamp,
- session id where applicable,
- file path or artifact URI,
- summary.

## State Provenance Contract

Every kernel argument in a runtime dispatch must have provenance. Provenance must come from runtime observation or verified host-path preservation, not from AI text alone.

### Argument Provenance Categories

Each argument must be classified as one of:

- `host_struct_field`
- `host_global`
- `host_stack_local`
- `device_allocation`
- `managed_allocation`
- `texture_object`
- `surface_object`
- `constant_memory_symbol`
- `device_global_symbol`
- `hiprt_accel_handle`
- `cuda_graph_node`
- `stream`
- `event`
- `generated_temporary`
- `literal`
- `unknown`

### Required Argument Record

Each runtime-observed argument should produce a record:

```json
{
  "kernel": "MegaKernel",
  "argIndex": 0,
  "argName": "render_data",
  "sourceCategory": "host_struct_field",
  "ownerExpression": "renderer.render_data",
  "runtimeOwnerId": "renderer:0x...",
  "valueAddress": "0x...",
  "pointeeAddress": "0x...",
  "addressSpace": "device",
  "allocationId": "alloc:...",
  "allocationSize": 14745600,
  "layoutHash": "sha256:...",
  "provenance": "runtime_observed",
  "confidence": "verified"
}
```

The exact field set may vary by vendor/runtime, but the report must distinguish runtime-observed evidence from generated or static evidence.

### Full Correctness Blocking Rules

Block full runtime correctness if any dispatched argument is:

- `unknown`,
- `generated_temporary`,
- a null pointer where source semantics require a live object,
- a pointer without allocation ownership,
- a pointer whose allocation size is smaller than the kernel-visible access contract,
- a struct whose layout hash is unverified,
- a HIPRT/CUDA handle without runtime provenance,
- a stream/event whose ordering role is unknown,
- a texture/surface object whose binding is unverified.

## ABI Compatibility Gate

The ABI gate must compare source, compiled artifact, and live runtime expectations.

### Required ABI Inputs

Inputs:

- source symbol identity,
- mangled/exported symbol identity,
- demangled symbol identity where available,
- parameter count,
- parameter sizes,
- parameter alignments,
- parameter type names where available,
- struct/class/union layout hash,
- constant memory layout hash,
- device global layout hash,
- texture/surface binding hash,
- address-space classification,
- launch bounds,
- required shared memory,
- compiler flags hash,
- device library linkage identity,
- target ISA/arch,
- artifact schema version.

### ABI Extractor Contract

Every ABI hash must declare its extractor. An ABI field with no concrete extractor is unverified and must downgrade to `gpu-hmr-abi-unverified`.

Accepted extraction sources:

- Clang AST or clang record-layout dump for kernel parameter types, struct/class/union layouts, field offsets, field sizes, alignments, and host/device-visible type identities.
- Compiled artifact symbol table for exported, mangled, and demangled symbol identity.
- Compiler invocation metadata for target ISA/arch, flags, include roots, and device library identity.
- DWARF or LLVM metadata as a cross-check when debug metadata is present and trustworthy.
- Runtime metadata only when the runtime boundary explicitly records it with a stable schema and artifact/session id.
- Vendor/runtime wrapper instrumentation for texture objects, surface objects, CUDA graph nodes, HIPRT handles, streams, and events.

Rejected extraction sources for ABI proof:

- regex-only source scanning,
- AI text,
- logs without a structured evidence id,
- inferred struct layout from generated launch aggregates,
- assumed texture/surface bindings,
- guessed parameter sizes or alignments.

V1 ABI proof scope:

- Prove kernel signature, exported symbol identity, compiler command, target arch, source include root, device/global constant layout, and parameter-visible record layouts through Clang AST/layout dumps where available.
- Treat texture/surface binding metadata as unverified unless the runtime wrapper or compiler metadata exposes it explicitly.
- Treat HIPRT/CUDA opaque handles as ABI-safe only for type identity; runtime handle provenance is handled by dispatch safety, not ABI proof.

### ABI Safe Scope

Safe hot replacement requires:

- function/kernel body change only,
- no kernel signature change,
- no device function signature change that affects callers,
- no new required external symbol,
- no removed required external symbol,
- no changed constant memory layout,
- no changed device global layout,
- no changed texture/surface binding,
- no changed struct/class/union layout visible across host/device boundary,
- no changed allocation size expectation,
- no changed host/device protocol,
- no new required pre-pass,
- no changed include graph root,
- no macro-controlled ABI uncertainty.

### ABI Unsafe Scope

Unsafe changes include:

- kernel signature change,
- struct/class/union layout change,
- device global or constant layout change,
- texture/surface binding change,
- allocation size expectation change,
- host/device protocol change,
- new required pre-pass,
- new required synchronization rule,
- changed kernel launch order,
- changed stream/event semantics,
- changed target arch assumptions,
- changed compiler semantics through flags or defines.

Unsafe changes must require host rebuild, full restart, or explicit degraded result. They must not be reported as normal partial HMR.

## Stream And Ordering Proof

Runtime correctness requires actual ordering evidence, not just a static "this kernel runs before/after that kernel" summary.

### Required Runtime Ordering Evidence

For each relevant launch:

- stream id or stable stream identity,
- event dependencies,
- graph capture state,
- synchronization points,
- in-flight kernel status at reload time,
- module lifetime state,
- reload drain/synchronize result,
- old artifact version,
- new artifact version,
- first dispatch after reload.

### Reload Safety Rule

Reloading while old kernels from the replaced artifact are in flight is forbidden unless the runtime proves synchronization.

Accepted synchronization evidence:

- stream synchronization completed for all streams that could dispatch the replaced symbol,
- event dependency chain proves no in-flight old artifact call remains,
- graph replay is stopped or rebuilt,
- runtime reports no in-flight kernel for the selected module/symbol.

Missing ordering evidence downgrades to compile/symbol/ABI proof only.

## Epoch-Grafted Artifact Capsules

The target production replacement model is an epoch-grafted capsule system modeled on organ grafting plus blood circulation.

Instead of treating HMR as "compile, unload old module, synchronize everything, load new module," the runtime owns small living capsule generations.

```text
stable host dispatch table
    |
    | points to current capsule generation
    v
capsule generation N:
    - fissioned code object
    - ABI membrane hash
    - exported symbol set
    - dependency closure hash
    - function handles
    - proof hash
    - stream epoch counters
```

### Capsule Contents

Each capsule generation must record:

- generation id,
- artifact id,
- artifact kind,
- artifact hash,
- loader backend,
- loader capability record,
- fission island id,
- fissioned code object bytes hash,
- ABI membrane hash,
- ABI proof id,
- exported symbol set,
- dependency closure hash,
- compile command hash,
- function handle ids,
- dispatch table hash contribution,
- proof hash,
- stream epoch counters,
- creation timestamp,
- publish timestamp,
- retirement state.

The capsule record must be generic across GPU vendors. It may mention HIPRT, CUDA, ROCm, OptiX, Vulkan compute, or other backends only as observed runtime/toolchain metadata.

### Epoch Swap Flow

On edit:

1. Prove the edit stays inside an ABI membrane.
2. Compile only the fission island, preferably with RAM artifact transport.
3. Load the new capsule into memory.
4. Resolve function handles for the exported symbol set.
5. Hash the dispatch table before publish.
6. Atomically publish dispatch entries to generation `N+1`.
7. Hash the dispatch table after publish.
8. Keep generation `N` alive.
9. Record which streams can still use generation `N`.
10. Insert or observe retirement fences for those streams.
11. Retire and unload generation `N` only after every relevant stream passes its epoch fence.

The publication step is the moment the runtime may claim `gpu-hmr-epoch-swap-proven`, provided the proof artifact records the generation lineage and retirement evidence. If old generation retirement is still pending, the proof must say so explicitly.

### Why This Is Better Than Full Synchronize-Then-Swap

Full synchronization before swap is simple but pessimistic. It stalls unrelated work and can hide whether the replacement was actually safe for in-flight launches.

Epoch capsules separate three facts:

- new generation publication,
- old generation lifetime,
- old generation retirement.

That separation gives a stronger proof: old launches finish on old code, new launches use new code, and module unload is delayed until stream evidence allows it.

### Dispatch Table Rules

The stable host dispatch table must not be rebuilt by generated renderer logic for complex projects. It should be owned by the runtime boundary and point to capsule generations.

Dispatch table updates must be:

- atomic at the logical symbol entry level,
- generation stamped,
- hashable before and after publish,
- scoped to verified replacement symbols,
- rejected if the new capsule exports unknown unsafe symbols,
- rejected if ABI membrane proof failed,
- rejected if function handle resolution is incomplete.

### Retirement Rules

Old capsules must stay loaded while any stream can still dispatch or finish work from that generation.

Required retirement evidence:

- stream id,
- old generation id,
- last observed launch id for that generation on the stream,
- event/fence id,
- fence insertion timestamp,
- fence completion timestamp,
- unload timestamp,
- unload driver result.

If a backend cannot expose per-stream fences or events for the affected launch path, the system may fall back to conservative stream/context synchronization, but it must record that as a degraded retirement strategy. It must not pretend the run used epoch retirement.

## RAM Artifact Transport Contract

The target fast path should avoid unnecessary disk round trips between compile, artifact selection, reload, and proof collection.

RAM artifact transport means the selected fission island artifact is carried through the pipeline as bytes or as a content-addressed in-memory blob reference, not only as a filesystem path.

### RAM Transport Goals

RAM transport should reduce:

- compile-to-load latency,
- filesystem contention,
- stale artifact risk,
- accidental cross-session artifact selection,
- path-specific behavior in tests and fixtures.

### RAM Transport Artifact Record

Each RAM-capable artifact must record:

```json
{
  "artifactId": "artifact:...",
  "transport": "ram",
  "artifactKind": "source_include_bridge",
  "bytesHash": "sha256:...",
  "bytesLength": 123456,
  "exportedSymbols": ["..."],
  "compileCommandHash": "sha256:...",
  "dependencyClosureHash": "sha256:...",
  "loaderCapability": "module-load-data",
  "fallbackPath": null
}
```

If a backend requires a path-based loader, the artifact record must say:

```json
{
  "transport": "filesystem-fallback",
  "requestedTransport": "ram",
  "degradedState": "gpu-hmr-ram-io-unavailable",
  "loaderCapability": "module-load-file",
  "fallbackPathHash": "sha256:..."
}
```

### RAM I/O Insertion Points

RAM I/O should be added at these subsystem boundaries:

- compile output: device compilation emits artifact bytes or a RAM blob id in addition to any path,
- partial artifact selection: selected fission island carries bytes/hash/symbol metadata forward,
- reload request: adapter accepts either artifact bytes/blob id or verified artifact path,
- module manager load API: backend loader chooses data load, file load, or explicit fallback based on capability,
- proof writer: proof artifact references bytes hash/blob id as the source of truth,
- MCP validation: validation reads proof artifact and evidence refs, not stale paths.

### Loader Capability Rule

RAM transport must be capability-driven. It must not hardcode behavior for HIPRT, ROCm, CUDA, a renderer name, or a fixture path.

Accepted capability examples:

- `module-load-data`,
- `module-load-file`,
- `module-load-data-disabled-by-backend`,
- `module-load-data-unsafe-on-target`,
- `memfd-or-tempfile-required`,
- `unknown`.

If a backend has a known unsafe byte-load path, the system must use the safer loader and report the fallback. Correctness beats RAM purity.

## Vectant Implementation Surface Map

This section maps the architecture to the existing Vectant subsystems. It is intentionally file-level rather than fixture-level. The implementation must keep these boundaries generic and must not hardcode HIPRT, renderer names, symbol names, paths, or fixture behavior.

### GPU Module Ownership

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_manager.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`

Current role:

- Owns primary and standby module slots.
- Tracks partial modules.
- Resolves kernel function handles.
- Merges partial reloads into the active kernel table.
- Promotes standby to primary.
- Unloads retired modules immediately after the reload transaction.

Target role:

- Own the capsule generation registry.
- Replace primary/standby-only semantics with `CapsuleGeneration` records.
- Track generation id, artifact id, ABI membrane hash, exported symbol set, dependency closure hash, function handles, proof hash, stream epochs, and retirement state.
- Publish dispatch entries by generation.
- Keep retired generations alive until stream epoch retirement proves they can be unloaded.

Required changes:

- Add a capsule generation data model.
- Add dispatch table hash computation before and after publish.
- Add generation lineage records to the proof artifact.
- Split "publish new generation" from "retire old generation."
- Preserve existing full-drain behavior as a conservative fallback when epoch retirement is unavailable.

### Reload Transaction

Primary file:

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`

Current role:

- Reads the selected artifact from a filesystem path.
- Drains the context before loading on non-first loads.
- Loads standby module.
- Resolves function handles.
- Swaps or merges the module table.
- Immediately unloads retired modules.
- Installs a new launch dispatcher.

Target role:

- Accept a verified artifact path, RAM artifact bytes, or RAM blob id.
- Load the new artifact as a capsule candidate.
- Resolve all required function handles before publication.
- Validate ABI membrane, symbol ownership, and replacement scope before publication.
- Atomically publish dispatch entries to the new generation.
- Register retirement fences for old generations.
- Defer unload until retirement proof passes.

Required changes:

- Introduce a reload request artifact source enum.
- Add loader capability detection/reporting.
- Move synchronization from mandatory pre-swap full-context drain to capability-driven epoch retirement, with conservative drain fallback.
- Emit `gpu-hmr-epoch-swap-proven`, `gpu-hmr-epoch-retirement-pending`, or `gpu-hmr-epoch-swap-unverified` as appropriate.

### Stable Runtime Launch Boundary

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/runtime/gpu_runtime_boundary.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/gpu_runtime_contract.rs`

Current role:

- Provides `synthi_gpu_launch` and raw checked launch wrappers.
- Maintains a launch generation.
- Records launch attempts.
- Routes launches through an installed dispatcher.
- Captures stream token and launch dimensions.

Target role:

- Keep the host-facing launch ABI stable.
- Move from one global dispatcher generation to symbol/generation dispatch entries.
- Record the capsule generation actually used by each launch.
- Record dispatch-observed evidence into structured proof artifacts.
- Provide runtime hooks needed for argument provenance, stream identity, and output probe correlation.

Required changes:

- Add per-symbol dispatch generation ids.
- Add launch records that include artifact id, capsule id, and dispatch table entry id.
- Preserve stale-pointer rejection, but make the evidence structured.
- Ensure generated host code cannot fake full runtime proof by calling a regenerated launch path with invented state.

### Stream Retirement And Ordering

Primary file:

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_stream_drain.rs`

Current role:

- Provides context synchronization and stream synchronization helpers.
- Records drain scope, elapsed time, and driver result.

Target role:

- Track stream usage by capsule generation.
- Insert or observe retirement fences for streams that may still use the old generation.
- Query fence completion.
- Allow old capsules to unload only after all relevant fences pass.
- Fall back to full stream/context drain only when finer-grained epoch retirement is unavailable.

Required changes:

- Add event/fence abstraction with backend capability metadata.
- Add retirement fence ids to proof artifact evidence.
- Distinguish "epoch retirement proven" from "context drain fallback used."
- Reject or degrade graph-capture/replay paths until ordering evidence exists.

### Fission Engine And Deterministic Fast Path

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_device_fast_path.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_prod_contracts.rs`

Current role:

- Detects device-only edits.
- Builds partial device sources.
- Supports source include bridge partial artifacts.
- Selects partial artifact catalog entries.
- Validates symbol ownership and safe export sets.
- Writes sidecar verifier reports and reload plan reports.

Target role:

- Formalize candidate selection as `FissionIsland`.
- Emit deterministic acceptance/rejection evidence for source spans, include closure, symbol ownership, dependency closure, ABI membrane, and oracle requirement.
- Provide structured rejection reasons to GPU AI delta when local proof fails.
- Keep deterministic local proof as the first path.

Required changes:

- Add `FissionIsland` schema and verifier result schema.
- Promote existing partial artifact selection metadata into fission island fields.
- Normalize rejection reason codes so AI delta, UI, MCP validation, and proof artifacts share the same vocabulary.
- Record accepted/rejected fission candidates in the structured proof artifact.

### Device Compile And RAM Artifact Output

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_device.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`

Current role:

- Writes device source to disk.
- Compiles a loadable device artifact.
- Records artifact path, bytes, exported symbols, selected artifact kind, and timing.
- Uses artifact cache keys and dependency hashes.

Target role:

- Emit a content-addressed artifact id.
- Carry artifact bytes or RAM blob ids alongside filesystem paths.
- Record artifact bytes hash and dependency closure hash as proof evidence.
- Preserve path-based artifact loading only as a loader capability fallback.

Required changes:

- Add artifact source transport metadata: `ram`, `filesystem`, or `filesystem-fallback`.
- Add RAM blob id and bytes hash to compile output.
- Extend reload packaging to carry artifact bytes/blob id when supported.
- Keep artifact cache behavior content-addressed so RAM transport does not remove reproducibility.

### Manifest And Reload Request Shape

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs`
- `ai-backend/ai-engine/build_manifest.py`
- `backend/synthi-webrtc-compiler/worker/src/hmr/integration.rs`

Current role:

- Describes generated roles, GPU vendor/toolchain settings, artifact path, artifact hash, exported symbols, and capabilities.
- Bridges AI-side manifest output into worker-side reload behavior.

Target role:

- Allow reload requests to carry either `artifact_path` or a RAM artifact reference.
- Carry fission island ids, ABI membrane ids, loader capability requirements, and oracle requirements.
- Preserve compatibility with path-only backends by recording explicit degraded transport states.

Required changes:

- Extend manifest/reload schemas with optional artifact transport fields.
- Keep path fields for compatibility, but make proof artifacts identify the selected artifact by content hash/id.
- Validate that RAM artifact metadata and path artifact metadata agree when both are present.

### GPU AI Delta And Agentic Planning

Primary files:

- `ai-backend/ai-engine/agents/gpu_mod_delta.py`
- `ai-backend/ai-engine/main.py`
- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
- `ai-backend/ai-engine/agents/kernel_splitter.py`

Current role:

- `/refactor/diff_patch/gpu` produces anchor-based edit lists and a reload-plan hint.
- Rust applies edits, verifies policies, updates sidecar state, and prepares partial device compile packages.
- `AiDeltaDeviceScope` already carries source, filename, symbols, artifact kind, source paths, dependency hash, compile command hash, and verifier evidence id.

Target role:

- Evolve GPU AI delta into an AI fission planner.
- Return optional `fissionCandidate` data with proposed source spans, symbols, artifact kind, include closure, expected ABI scope, and oracle proposal.
- Use AI delta only after deterministic local proof fails or when explicitly requested for repair/planning.
- Keep AI out of proof certification.

Required changes:

- Extend GPU delta prompt/response parsing with optional `fissionCandidate`.
- Pass deterministic local proof rejection reasons into the prompt.
- Record AI proposal ids separately from deterministic verifier evidence ids.
- Reject AI proposals that fail deterministic ABI, symbol, dependency, oracle, provenance, or stream checks.

### Proof Storage And Validation

Primary files:

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_prod_contracts.rs`
- MCP validation scripts under `mcp/synthi-mcp/scripts`
- frontend status surfaces under `synthi/src/components` and `synthi/src/lib`

Current role:

- Normalizes split sidecar contracts.
- Promotes verifier reports into run reports.
- MCP validation currently consumes tool output, logs, screenshots, and status state.
- UI reports HMR status and GPU HMR state.

Target role:

- Make structured proof artifacts the source of truth.
- Reference logs, screenshots, hashes, compile output, and visual evidence as evidence refs only.
- Surface degraded states exactly, including epoch, RAM transport, AI-delta fallback, and output-oracle gaps.

Required changes:

- Add proof artifact writer and reader.
- Update MCP validation to read proof artifact result states.
- Update UI labels to avoid claiming full runtime correctness unless `gpu-hmr-full-runtime-proven`.
- Ensure `synthi_compile`, `synthi_wait_hmr`, and `synthi_screenshot` validation links visual evidence to proof artifacts rather than treating screenshots as proof.

## Replacement Scope Contract

Replacement scope must be formal. The runtime must know whether it is replacing:

- one kernel symbol,
- a safe multi-symbol artifact,
- a full device module,
- a host module,
- a GUI module,
- the runner process.

### Safe Device-Only Replacement

Safe device-only replacement requires:

- selected artifact is partial,
- selected symbol set is non-empty,
- exported symbols equal expected symbols or verifier-approved safe superset,
- no unknown symbols,
- ABI gate passed,
- runtime touched only expected symbols,
- primary/full module was not replaced,
- host/core/gui identities unchanged,
- no restart,
- fallback was not used.

### Degraded Replacement

Any of the following requires degraded reporting:

- full device module replaced,
- host module rebuilt,
- GUI module rebuilt,
- runner restarted,
- full-device fallback used,
- selected artifact exports unknown symbols,
- safe superset not proven,
- ABI evidence missing,
- dispatch evidence missing,
- output evidence missing.

## Grand Fission Engine

The grand fission engine is the subsystem that decides how narrow a replacement artifact can be before compilation and capsule publication.

It must be generic: fission is about dependency, ABI, symbol, and runtime ownership boundaries. It is not a HIPRT-specific, CUDA-specific, ROCm-specific, or renderer-specific trick.

### Fission Island

A fission island is a proposed hot-reloadable unit.

Required island fields:

- island id,
- source edit id,
- source paths,
- source spans,
- generated role path where applicable,
- target symbols,
- exported symbols expected from artifact,
- artifact kind,
- include closure,
- dependency closure hash,
- ABI membrane id,
- compile recipe hash,
- compile command hash,
- loader capability requirement,
- output oracle proposal or required oracle id,
- original host launch mapping id where applicable,
- verifier evidence ids,
- AI proposal id when AI was involved.

### Fission Pipeline

The engine should run this pipeline:

1. Discover changed source spans.
2. Map spans to source-backed or generated device roles.
3. Propose candidate fission islands.
4. Deterministically verify source mapping and include closure.
5. Deterministically verify symbol ownership and safe export set.
6. Deterministically verify ABI membrane compatibility.
7. Select the narrowest viable island.
8. Compile the island, preferably through RAM artifact transport.
9. Load it as a capsule generation.
10. Publish through epoch dispatch.
11. Run dispatch, output, visual, and host-preservation proof.

### Narrow Fission First

The selection preference should be:

1. single body-only kernel/function replacement,
2. source-include-backed partial artifact,
3. safe multi-symbol artifact,
4. full device sidecar,
5. host rebuild,
6. runner restart.

The system may choose a wider scope only when the structured proof artifact records why narrower candidates were rejected.

### Fission Rejection Reasons

Common rejection reasons:

- edit crosses ABI membrane,
- include closure unknown,
- symbol ownership ambiguous,
- exported symbols include unsafe unknowns,
- compile recipe unavailable,
- RAM loader capability unavailable,
- argument provenance would be unknown,
- output oracle missing,
- original host launch mapping missing,
- stream retirement cannot be proven.

These reasons should be reusable by AI delta as repair context, but they remain deterministic verifier outputs.

## Deterministic Probe Contract

Full runtime correctness for renderers requires deterministic probe mode and an explicit output oracle.

### Probe Mode Requirements

The runtime or validation harness must set:

- fixed scene,
- fixed camera,
- fixed seed,
- fixed frame index,
- fixed sample count,
- accumulation reset,
- stable dispatch order,
- stable render settings,
- stable denoising/postprocessing state,
- known output target,
- known synchronization point before readback.

### Output Oracle Requirements

An output oracle must define what result is expected before validation runs. "A frame changed", "a hash changed", or "the screenshot is non-black" is not an oracle.

Accepted oracle kinds:

- edit contract: a declared before/after expectation for the edit,
- sentinel buffer value,
- kernel-side checksum,
- render target hash with a known expected hash,
- accumulation buffer hash with a known expected hash,
- selected pixel values with tolerance,
- per-pass checksum,
- dispatch counter with expected increment.

Required oracle record fields:

- oracle id,
- oracle kind,
- producer,
- expected value,
- actual value,
- tolerance where applicable,
- pass/fail status,
- output target id,
- readback timestamp after HMR,
- session id,
- artifact id,
- visual evidence ref for render workflows.

### Probe Outputs

At least one deterministic output must be captured:

- render target hash,
- accumulation buffer hash,
- sentinel buffer value,
- dispatch counter,
- selected pixel values with tolerance,
- kernel-side checksum,
- per-pass checksum.

### Floating Point Tolerance

For floating point renderers:

- bit-exact hash is allowed only when the pipeline is proven bit-stable,
- otherwise use numeric tolerance per pixel/channel/checksum,
- tolerance must be recorded,
- expected nondeterminism must be bounded and explained.

### Probe Result Schema

```json
{
  "probeMode": "fixed_scene",
  "sceneId": "cornell-box-fixed",
  "cameraHash": "sha256:...",
  "seed": 1234,
  "frameIndex": 1,
  "sampleCount": 1,
  "accumulationReset": true,
  "dispatchOrderHash": "sha256:...",
  "outputTarget": "render_target_rgba32f",
  "check": {
    "kind": "selected_pixels",
    "expected": [[128, 128, [0.22, 0.18, 0.13, 1.0]]],
    "actual": [[128, 128, [0.221, 0.181, 0.131, 1.0]]],
    "tolerance": 0.005,
    "passed": true
  }
}
```

For render workflows, `synthi_screenshot` or equivalent fresh visual capture is still required as visual evidence. Visual evidence cannot replace the oracle.

## Host Preservation Proof

The system must prove it did not replace too much.

Host preservation cannot be proven by reading logs after the run. The runtime must snapshot identities before and after the HMR window and write those records into the structured proof artifact.

### Required Identity Checks

Record before and after:

- runner process identity,
- host/core module identity,
- GUI module identity,
- renderer object identity,
- core state pointer,
- GUI state pointer,
- project session id,
- device primary context identity,
- stream identities,
- persistent allocation identities,
- scene buffer identities,
- acceleration structure handle identities where available,
- output buffer identity.

### Negative Proof Examples

The validation must assert:

- host module identity unchanged,
- GUI state pointer unchanged,
- renderer object identity unchanged,
- scene buffers unchanged unless expected,
- only selected GPU artifact version changed,
- primary/full device module not replaced when partial HMR is required,
- no runner restart occurred during the HMR window.

If any assertion fails, report `gpu-hmr-host-replaced` or a narrower degraded state.

### Host Preservation Instrumentation Contract

The runtime must intentionally instrument identities it later claims as preserved.

Required instrumentation sources:

- runner process identity from the runner process itself,
- host/core module identity from the module loader,
- GUI module identity from the module loader,
- core and GUI state pointers from the runtime call boundary,
- project session id from runner session state,
- device context identity from the GPU runtime wrapper where available,
- stream identities from the GPU runtime wrapper where available,
- persistent allocation identities from allocation registration/wrappers,
- output buffer identity from probe registration.

Renderer object identity, scene buffer identity, HIPRT acceleration handles, texture objects, surface objects, graph nodes, and event dependencies are optional only until a renderer adapter or runtime wrapper records them. If they are required for a project class and no instrumentation exists, host preservation must be degraded rather than inferred.

## Original Host Path Attachment

The preferred architecture for complex projects is not to regenerate the renderer core. It is to attach device HMR to the original host path.

### Architecture

1. Build or run the original project host path.
2. Inject or link a Synthi runtime boundary that can:
   - observe kernel registrations,
   - observe launches,
   - observe stream/event ordering,
   - observe device allocations,
   - accept replacement artifacts,
   - swap dispatch tables after synchronization.
3. Use CodeIntel/RAG to map source edit to target-scoped device artifact.
4. Compile narrow replacement artifact.
5. Validate symbol and ABI compatibility.
6. Synchronize affected streams.
7. Swap only selected dispatch entries.
8. Resume original host path.
9. Collect dispatch and output proof from the original runtime.

### Why This Is Required

Large renderers maintain runtime state that cannot be reconstructed from source alone. The original runtime already has:

- live scene,
- live camera,
- live buffers,
- live HIPRT/CUDA handles,
- stream/event graph,
- UI settings,
- accumulation history,
- allocator state.

The production system should preserve and instrument that state, not invent it.

## AI Role

AI may assist, but it must not certify runtime correctness.

### AI May Help With

- locating likely launch sites,
- summarizing source launch graph,
- proposing deterministic probe points,
- proposing runtime instrumentation insertion points,
- explaining rejected proof states,
- proposing patch candidates for non-body edits,
- generating test scaffolds that deterministic verifiers then check.

### Existing GPU AI Delta Role

The existing GPU AI delta path is the correct front door for AI-assisted fission. It should evolve from "patch generated roles" into "propose a scoped fission candidate."

Current useful responsibilities:

- translate a user edit into generated-role edits,
- preserve anchor-based edit application,
- carry reload-plan hints,
- operate on scoped device prompt sources,
- let Rust apply deterministic policy and ABI checks after the model responds.

Production responsibilities to add:

- propose fission island fields,
- propose affected symbol set,
- propose source/include closure,
- propose artifact kind,
- propose output oracle candidates,
- include the local proof failure reasons it is trying to repair,
- return a structured proposal id that the proof artifact can reference.

Suggested AI delta response extension:

```json
{
  "reload_plan": "device_only",
  "edits": [],
  "fissionCandidate": {
    "sourcePaths": [],
    "sourceSpans": [],
    "symbols": [],
    "artifactKind": "source_include_bridge",
    "expectedAbiScope": "membrane-preserving",
    "oracleProposal": {
      "kind": "pixel-or-checksum",
      "target": "deterministic-output-contract"
    }
  }
}
```

The runtime must treat this as a proposal. It becomes a real fission island only after deterministic verification.

### Local Proof And AI Delta Fallback Policy

AI delta is fallback for candidate generation, never fallback for proof.

The correct flow is:

```text
local deterministic proof
  -> pass: compile capsule
  -> fail: AI delta proposes repair/fission candidate
        -> deterministic proof again
              -> pass: compile capsule
              -> fail: full rebuild / cold reload / degraded state
```

If local proof fails before runtime publication, AI delta may be called with structured reason codes such as:

- `mapping_ambiguous`,
- `partial_artifact_unavailable`,
- `symbol_ownership_uncertain`,
- `abi_membrane_rejected`,
- `include_closure_unknown`,
- `output_oracle_missing`,
- `ram_transport_unavailable`,
- `epoch_retirement_unavailable`.

AI may propose a narrower island, a safer generated-role patch, an oracle, or a repair. The deterministic verifier must re-check everything before compile/load/publish.

If proof fails after runtime publication stages, AI delta must not bless the failed artifact. The runtime must keep or roll back to the old generation, quarantine or reject the new capsule, write the structured proof failure, and optionally send that failure report to AI delta or GPU heal to propose a new attempt.

### AI Agent Plug-In Points

Useful AI plug-ins:

- fission planner: proposes island boundaries and target symbols,
- oracle designer: proposes sentinel/checksum/pixel probes,
- launch attachment scout: suggests original host launch instrumentation points,
- proof failure explainer: turns structured rejection reasons into developer-readable guidance,
- fission cache ranker: ranks likely fast paths using prior timings,
- repair proposer: proposes scoped edits after compile/proof rejection.

These agents must output structured proposals with ids. They must not write proof states.

### AI Must Not Decide

- ABI safety,
- pointer provenance,
- stream ordering safety,
- output correctness,
- host preservation correctness,
- whether a generated temporary is equivalent to live renderer state.

AI also must not decide:

- that an epoch swap is safe,
- that an old generation can be unloaded,
- that RAM transport happened,
- that a backend-specific loader behavior is safe without capability evidence,
- that a visual screenshot satisfies an output oracle.

### AI Body-Only Edit Classification

AI can be used as advisory evidence for body-only classification only after deterministic checks run.

Allowed use:

- ask AI to explain whether a confusing diff appears body-only,
- include AI reasoning in telemetry as non-authoritative,
- require deterministic verifier to accept or reject.

Rejected use:

- AI says "safe" and system accepts without deterministic proof,
- AI infers missing launch state,
- AI invents device pointers, HIPRT handles, streams, or material buffers.

## Generated Artifact Patching

Patching generated artifacts directly is not the preferred full-correctness path for complex renderers.

### When Generated Artifact Patching Is Safe

It can be safe for:

- generated kernels whose source of truth is the generated role,
- direct body-only edits where ABI/layout/directives are unchanged,
- small projects where runtime launch state is owned by generated core,
- deterministic local proof with no AI delta.

### When Generated Artifact Patching Is Not Enough

It is not enough for full correctness when:

- generated artifact includes source-backed complex kernels,
- launch state is owned by the original renderer,
- arguments include HIPRT/CUDA handles,
- output correctness depends on original host state,
- stream/event ordering is external to generated core.

For HIPRT-scale projects, generated artifact patching can prove compile/symbol/reload layers. It cannot prove render correctness without original host path attachment or runtime-captured provenance.

## Implementation Milestones

### Milestone 1: Truthful Proof-State Reporting

Goal:

Make every result report the highest proof state actually achieved through a structured proof artifact.

Implementation:

- Add proof-state enum in worker/runtime telemetry.
- Add degraded/failure states listed in this plan.
- Add structured proof artifact schema and writer.
- Emit proof-state transitions from compile, symbol inspection, ABI gate, reload, dispatch observation, output probe, and host preservation checks.
- Make MCP validation read proof artifacts as source of truth rather than inferring correctness from logs.
- Update MCP validation to fail if it expected full runtime proof but only received compile/reload proof.
- Update UI/terminal labels to show proof state clearly.

Tests:

- compile-only result reports `gpu-hmr-compile-proven`,
- symbol-bound result reports `gpu-hmr-symbol-bound`,
- partial reload without dispatch reports `gpu-hmr-dispatch-unobserved`,
- observed dispatch with unsafe/unknown arguments reports `gpu-hmr-dispatch-observed` but not `gpu-hmr-dispatch-safe-proven`,
- visual-only result reports `gpu-hmr-visual-only`,
- host restart during device HMR reports `gpu-hmr-host-replaced`,
- no success path silently reports full runtime proof without output probe.

### Milestone 2: Runtime Argument Provenance

Goal:

Record and validate provenance for every launched kernel argument.

Implementation:

- Extend `synthi_gpu_launch` boundary to capture argument metadata where possible.
- Track registered device allocations and map pointer arguments to allocation ids.
- Track constant memory and device global symbols from artifact inspection.
- Record texture/surface objects when runtime API wrappers expose them.
- Classify unknown/generated temporaries explicitly.
- Reject full runtime proof if provenance is incomplete.

Tests:

- device pointer registered through `synthi_register` maps to `device_allocation`,
- null pointer for pointer-bearing render data blocks full runtime proof,
- generated temporary aggregate reports `generated_temporary`,
- unknown pointer reports `unknown`,
- all-proven small fixture reaches dispatch/output proof.

### Milestone 3: ABI Compatibility Gate

Goal:

Replace signature-hash-only thinking with a formal ABI gate.

Implementation:

- Extend artifact metadata with parameter count/size/alignment where available.
- Hash visible struct/class/union layouts from Clang AST or clang record-layout dumps.
- Hash constant memory and device global layouts from declared extractor output and compiled artifact symbols.
- Record texture/surface binding metadata only when compiler metadata or runtime wrapper instrumentation exposes it.
- Store extractor name, version, command, input hash, and evidence id for every ABI hash.
- Compare compile command, target arch, compiler version, and device library identity.
- Fail ABI proof on layout, binding, symbol, or flag uncertainty.

Tests:

- body-only edit passes ABI gate,
- kernel parameter change fails,
- struct layout change fails,
- `__constant__` layout change fails,
- device global change fails,
- texture binding change fails,
- compiler flag change downgrades or invalidates proof.

### Milestone 4: Stream And Ordering Enforcement

Goal:

Prevent reload while old code is in flight.

Implementation:

- Track streams that dispatch symbols from each artifact.
- Track in-flight launches where runtime API allows it.
- Drain/synchronize all affected streams before replacement.
- Record synchronization evidence.
- Reject or degrade if graph capture/replay state is active and cannot be safely paused.

Tests:

- reload waits for active stream to drain,
- reload rejects if affected stream cannot synchronize,
- unrelated stream does not block replacement,
- graph capture state blocks partial replacement unless explicitly handled.

### Milestone 5: Epoch Capsules And RAM Artifact Transport

Goal:

Replace primary/standby immediate-unload semantics with generation-published capsules and add RAM-capable artifact transport.

Implementation:

- Add capsule generation records to the GPU module manager.
- Add artifact ids, ABI membrane hashes, exported symbol sets, dependency closure hashes, function handle ids, proof hashes, and stream epoch counters to capsule metadata.
- Add dispatch table hash before/after publication.
- Publish changed dispatch entries atomically by generation.
- Keep old capsules loaded after publication.
- Track streams using old generations.
- Add retirement fence records and delayed unload.
- Add RAM artifact/blob id support to compile output and reload requests.
- Add backend loader capability records instead of vendor hardcoding.
- Record filesystem fallback as `gpu-hmr-ram-io-unavailable` when RAM load is unavailable or unsafe.
- Emit `gpu-hmr-epoch-swap-proven` stage evidence into the proof artifact.

Tests:

- new capsule generation publishes without unloading old generation,
- dispatch table hash changes only for expected symbols,
- old generation remains live while a stream fence is pending,
- old generation unloads only after fence completion,
- failed function resolution does not publish a generation,
- RAM artifact path loads through data loader when capability allows,
- file-loader fallback records degraded RAM transport state,
- proof artifact contains old/new generation lineage.

### Milestone 6: Host Preservation Proof

Goal:

Prove device HMR did not replace host/core/gui state.

Implementation:

- Record host/core/gui module identities before and after HMR.
- Record runner process identity.
- Record core/GUI state pointers.
- Record renderer object identity where runtime instrumentation exposes it.
- Record device context and stream identities.
- Fail full proof if host or runner identity changed unexpectedly.

Tests:

- pure device HMR preserves host identities,
- host rebuild downgrades proof,
- runner restart downgrades proof,
- scene buffer change without expected reason downgrades proof.

### Milestone 7: Deterministic Probe Framework

Goal:

Add output correctness proof backed by explicit oracles and fresh visual evidence for render workflows.

Implementation:

- Define small project readback probe first.
- Add generic probe API for kernel-side sentinel/checksum.
- Add edit contract schema for expected before/after output.
- Add renderer probe adapter interface.
- For HIPRT, start with a fixed-scene/fixed-camera/fixed-seed probe if the original runtime path can expose output buffers.
- Add tolerance policy for floating point.
- Write oracle results and visual evidence refs into the structured proof artifact.

Tests:

- small fixture before/after scalar check,
- small fixture buffer hash check,
- tolerant pixel comparison,
- missing output probe prevents `gpu-hmr-output-oracle-proven`,
- stale screenshot cannot satisfy output proof.

### Milestone 8: Grand Fission Engine And AI Delta Integration

Goal:

Turn GPU AI delta and deterministic fast-path selection into a generic fission engine.

Implementation:

- Define `FissionIsland` schema.
- Extend GPU AI delta response with optional `fissionCandidate`.
- Feed local proof rejection reasons into AI delta.
- Promote AI proposals only after deterministic verifier acceptance.
- Record AI proposal id and deterministic verifier evidence ids separately.
- Rank candidates by narrowness, proof completeness, compile cost, and historical timing.
- Generate or require output oracle contracts for selected islands.
- Preserve existing deterministic local path as first attempt.
- Ensure AI delta is fallback for candidate generation only, never proof.

Tests:

- local proof pass does not call AI delta,
- local proof failure calls AI delta with reason codes,
- AI fission proposal is rejected when deterministic verifier rejects ABI/layout/symbol evidence,
- accepted AI proposal records both AI proposal id and verifier evidence id,
- missing oracle proposal blocks output proof,
- post-publication proof failure quarantines new capsule instead of AI-blessing it.

### Milestone 9: Original Host Path Attachment

Goal:

Use the real host renderer path for complex projects.

Implementation:

- Build/run original project host path under Synthi instrumentation.
- Intercept or wrap kernel launches at the runtime boundary.
- Register live kernel symbols and artifacts.
- Attach partial artifact replacement to dispatch table.
- Preserve real renderer objects and buffers.
- Use deterministic probes to validate output.

Tests:

- original host path dispatch observed,
- selected partial artifact replaces one symbol,
- host object identity unchanged,
- stream synchronization occurs before swap,
- output probe passes after edit.

### Milestone 10: HIPRT Full Runtime Validation

Goal:

Prove HIPRT full runtime render correctness or clearly report the highest achieved proof state.

### HIPRT Target Progression

HIPRT validation must not rely only on `MegaKernel`.

Required HIPRT progression:

1. Prove a smaller non-`MegaKernel` HIPRT kernel or pass with a deterministic output oracle.
2. Prove a source-include-backed HIPRT partial artifact reload for that smaller target.
3. Prove original host-path dispatch and host-preservation for that smaller target.
4. Use `MegaKernel` as the final HIPRT acceptance target.

`MegaKernel` is the final target because it exercises the broadest runtime state surface: render data aggregate, scene buffers, HIPRT handles, material and camera state, accumulation, stream ordering, and render output correctness.

Required run metadata:

- proof artifact id,
- proof artifact schema version,
- repo URL,
- commit,
- target,
- entry file,
- edited source path,
- model,
- GPU vendor/arch,
- Docker image ids,
- target projection file count,
- skipped files with reasons,
- split artifact count,
- selected artifact,
- selected symbols,
- compile command hash,
- dependency hash,
- ABI proof id,
- epoch swap proof id,
- runtime session slug,
- stream ordering proof id,
- host preservation proof id,
- output probe id.

Acceptance:

- no fake launch path,
- no unknown argument provenance,
- selected artifact exports expected symbols only,
- ABI gate passes,
- epoch capsule publish passes or a lower degraded state is reported,
- dispatch is observed in the current session,
- dispatch safety proof passes,
- affected streams are synchronized,
- output oracle passes,
- fresh visual output is captured for render workflows,
- host/core/gui/renderer identity preserved,
- result state is `gpu-hmr-full-runtime-proven`.

If any item fails, the run must report the exact degraded state.

## Operational Command Surface

The validation workflow exposes strict and warm modes through `mcp/synthi-mcp/package.json`:

- `npm --prefix mcp/synthi-mcp run proof:real-rocm`
  - Runs the strict real ROCm validator with the default cold worker setup.
- `npm --prefix mcp/synthi-mcp run proof:real-rocm:warm`
  - Enables `SYNTHI_REAL_ROCM_REUSE_WORKER_REPO=1`.
  - Enables `SYNTHI_REAL_ROCM_CLEAN_BUILD=0`.
  - Reuses the worker repo and build directory only when the worker repo commit matches the host validation commit and the worker tree is clean.
  - Falls back to the original cold worker copy when reuse is unsafe.
- `npm --prefix mcp/synthi-mcp run proof:runtime-profile`
  - Runs the generic runtime-profile dispatcher.
  - Accepts `SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH` or `SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON`.
  - Profiles use `synthi.gpu.hmr.runtime_profile.v1` and describe adapter family, target, source delta, required kernels, reload symbol, and visual/oracle thresholds as data.
  - Unsupported adapter families fail closed with an explicit unsupported-adapter error. They must be added as adapter implementations, not project-name branches.
- `npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check`
  - Validates shipped runtime profiles and verifies unknown adapter families are rejected.
- `npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt`
  - Runs the generic runtime-profile dispatcher against the HIPRT `MegaKernel` profile in same-process mode.
- `npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt:camera-rays`
  - Runs the generic runtime-profile dispatcher against the smaller HIPRT `CameraRays` profile in same-process mode.
- `npm --prefix mcp/synthi-mcp run proof:hiprt:warm`
  - Runs the profile-driven HIPRT visual proof in fresh-process mode.
  - Supports `SYNTHI_HIPRT_WARM_PROFILE_PATH`, `SYNTHI_HIPRT_WARM_PROFILE_JSON`, and `SYNTHI_HIPRT_WARM_REQUIRED_KERNELS`.
  - Kept as a compatibility wrapper; new profiles should prefer `proof:runtime-profile`.
- `npm --prefix mcp/synthi-mcp run proof:hiprt:warm:camera-rays`
  - Runs the smaller non-`MegaKernel` `CameraRays` profile in fresh-process mode.
- `npm --prefix mcp/synthi-mcp run proof:hiprt:same-process`
  - Runs the profile-driven HIPRT visual proof in same-process mode.
  - Injects the runtime adapter, waits for a reload trigger, recompiles the selected HIPRT kernel inside the running process, relaunches the original HIPRT render path, and compares baseline/changed/diff images.
- `npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays`
  - Runs the smaller non-`MegaKernel` `CameraRays` profile in same-process mode.
  - If the HIPRT checkout exists but `build/HIPRTPathTracer` is absent, the runner bootstraps the CMake build before proving the hot reload.

The warm real-ROCm mode is a speed optimization, not a weaker proof mode. The report records `worker_repo_reuse`, including whether reuse was requested, whether it was accepted, the expected and actual commit, dirty count, and fallback reason.

## Validation Matrix

Run all proof-state tests across:

- small single-kernel ROCm project,
- small multi-kernel ROCm project,
- source-include-backed ROCm project,
- generated-source-backed ROCm project,
- HIPRT scale project,
- CUDA project,
- header body edit,
- device body edit,
- rejected ABI/layout edit,
- stream-in-flight edit,
- deterministic output edit,
- visual-only path,
- fallback opt-in path,
- fallback forbidden path.

## Commit Discipline

Each implementation patch should be committed separately:

1. proof-state enum and terminal/UI reporting,
2. MCP proof-state validation,
3. structured proof artifact writer,
4. argument provenance telemetry,
5. ABI extractor metadata,
6. dispatch observed/safe split,
7. stream ordering enforcement,
8. epoch capsule generation model,
9. RAM artifact transport abstraction,
10. delayed capsule retirement,
11. host preservation identity checks,
12. small deterministic oracle/readback probe,
13. GPU AI delta fission-candidate proposal,
14. grand fission engine verifier,
15. original host path attachment prototype,
16. HIPRT deterministic probe integration.

Before each commit:

- inspect the diff,
- run focused unit tests,
- rebuild affected Docker containers,
- run the smallest meaningful MCP validation,
- ensure no unrelated dirty files are staged.

## Production Readiness Criteria

The system is not production-grade for senior AMD/NVIDIA kernel engineers until:

- full proof-state ladder is implemented,
- structured proof artifact is the source of truth,
- fake launch paths are rejected,
- argument provenance is enforced,
- ABI compatibility is formal,
- stream ordering is proven,
- epoch capsule publication and retirement are proven,
- RAM artifact transport is implemented or degraded explicitly by capability,
- AI delta is constrained to candidate generation and repair proposals,
- the fission engine records deterministic acceptance/rejection evidence,
- partial replacement scope is enforced,
- deterministic output oracles exist,
- host preservation is proven,
- HIPRT or an equivalently complex project reaches `gpu-hmr-full-runtime-proven`,
- failures/degraded states are visible in terminal, UI, MCP artifacts, and logs,
- validation artifacts include exact commands, versions, image ids, timings, and proof ids.

Until then, accurate wording is:

- "partial artifact compile/reload proven" when only compile/symbol/reload passed,
- "dispatch observed" when session-scoped dispatch is observed but safety is unproven,
- "dispatch safe proven" when dispatch observation, ABI, argument provenance, stream ordering, and replacement scope all pass,
- "output oracle proven" when deterministic readback passes an explicit oracle,
- "full runtime proven" only when the entire ladder passes.
