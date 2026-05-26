# GPU HMR Full Runtime Correctness Plan

## Purpose

This plan defines what must be true before Synthi can claim GPU HMR full runtime render correctness for large, real renderer projects such as HIPRT-Path-Tracer.

The goal is deliberately stricter than "the device artifact compiled" or "the runtime accepted a sidecar reload." A senior GPU engineer should be able to trust the reported state without reading logs to discover hidden fallbacks, fake launch paths, stale screenshots, or session-crossed dispatch evidence.

The system must be hostile to fake success.

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

The system did not prove full HIPRT render correctness:

- No session-scoped `synthi_gpu_launch` line was observed for the HIPRT run.
- No post-HMR fresh frame was captured.
- No deterministic output/readback was verified.
- The generated core did not preserve the real HIPRT render loop.

Therefore HIPRT is currently partial artifact reload proven, not full runtime render proven.

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

### `gpu-hmr-dispatch-proven`

The current runtime session dispatched the expected kernel after the replacement.

Required evidence:

- workspace/session slug,
- runtime session marker found in logs,
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

This state does not imply output correctness.

### `gpu-hmr-output-proven`

The HMR edit changed or preserved output as expected in a deterministic probe.

Required evidence depends on the project class:

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

Screenshots are supplemental evidence. They are not enough for this state.

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
- dispatch proven,
- output proven,
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

- block `gpu-hmr-dispatch-proven` if the argument is used for launch,
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

- stop at dispatch-proven,
- require probe mode for full runtime correctness.

### `gpu-hmr-host-replaced`

The host/core/gui path was replaced, restarted, or state was reset while claiming device-only HMR.

Action:

- downgrade from host-preservation-proven,
- report replacement scope and reason,
- reject full runtime correctness unless the validation explicitly targeted a restart path.

### `gpu-hmr-visual-only`

A screenshot or visual frame exists, but no deterministic output proof exists.

Action:

- report visual evidence as supplemental,
- block output-proven and full-runtime-proven.

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

## Deterministic Probe Contract

Full runtime correctness for renderers requires deterministic probe mode.

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

## Host Preservation Proof

The system must prove it did not replace too much.

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

### AI Must Not Decide

- ABI safety,
- pointer provenance,
- stream ordering safety,
- output correctness,
- host preservation correctness,
- whether a generated temporary is equivalent to live renderer state.

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

Make every result report the highest proof state actually achieved.

Implementation:

- Add proof-state enum in worker/runtime telemetry.
- Add degraded/failure states listed in this plan.
- Emit proof-state transitions from compile, symbol inspection, ABI gate, reload, dispatch observation, output probe, and host preservation checks.
- Update MCP validation to fail if it expected full runtime proof but only received compile/reload proof.
- Update UI/terminal labels to show proof state clearly.

Tests:

- compile-only result reports `gpu-hmr-compile-proven`,
- symbol-bound result reports `gpu-hmr-symbol-bound`,
- partial reload without dispatch reports `gpu-hmr-dispatch-unobserved`,
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
- Hash visible struct/class/union layouts.
- Hash constant memory and device global layouts.
- Record texture/surface binding metadata.
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

### Milestone 5: Host Preservation Proof

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

### Milestone 6: Deterministic Probe Framework

Goal:

Add output correctness proof.

Implementation:

- Define small project readback probe first.
- Add generic probe API for kernel-side sentinel/checksum.
- Add renderer probe adapter interface.
- For HIPRT, start with a fixed-scene/fixed-camera/fixed-seed probe if the original runtime path can expose output buffers.
- Add tolerance policy for floating point.

Tests:

- small fixture before/after scalar check,
- small fixture buffer hash check,
- tolerant pixel comparison,
- missing output probe prevents `gpu-hmr-output-proven`,
- stale screenshot cannot satisfy output proof.

### Milestone 7: Original Host Path Attachment

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

### Milestone 8: HIPRT Full Runtime Validation

Goal:

Prove HIPRT full runtime render correctness or clearly report the highest achieved proof state.

Required run metadata:

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
- runtime session slug,
- stream ordering proof id,
- host preservation proof id,
- output probe id.

Acceptance:

- no fake launch path,
- no unknown argument provenance,
- selected artifact exports expected symbols only,
- ABI gate passes,
- affected streams are synchronized,
- runtime dispatches expected kernel in current session,
- output probe passes,
- host/core/gui/renderer identity preserved,
- result state is `gpu-hmr-full-runtime-proven`.

If any item fails, the run must report the exact degraded state.

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
3. argument provenance telemetry,
4. ABI gate metadata,
5. stream ordering enforcement,
6. host preservation identity checks,
7. small deterministic readback probe,
8. original host path attachment prototype,
9. HIPRT deterministic probe integration.

Before each commit:

- inspect the diff,
- run focused unit tests,
- rebuild affected Docker containers,
- run the smallest meaningful MCP validation,
- ensure no unrelated dirty files are staged.

## Production Readiness Criteria

The system is not production-grade for senior AMD/NVIDIA kernel engineers until:

- full proof-state ladder is implemented,
- fake launch paths are rejected,
- argument provenance is enforced,
- ABI compatibility is formal,
- stream ordering is proven,
- partial replacement scope is enforced,
- deterministic output probes exist,
- host preservation is proven,
- HIPRT or an equivalently complex project reaches `gpu-hmr-full-runtime-proven`,
- failures/degraded states are visible in terminal, UI, MCP artifacts, and logs,
- validation artifacts include exact commands, versions, image ids, timings, and proof ids.

Until then, accurate wording is:

- "partial artifact compile/reload proven" when only compile/symbol/reload passed,
- "dispatch proven" when session-scoped dispatch is observed,
- "output proven" when deterministic readback passes,
- "full runtime proven" only when the entire ladder passes.
