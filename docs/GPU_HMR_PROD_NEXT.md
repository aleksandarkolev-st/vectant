# GPU HMR Production Hardening Plan

Draft date: 2026-05-20

## 1. Objective

GPU HMR should become reliable for engineers working on real native GPU
projects, including repositories with hundreds or thousands of files.

The production goal is not merely "make generated GPU demos reload." The goal
is:

```text
real user project
  -> real build target selected
  -> deterministic source context selected
  -> AI split only when needed
  -> generated roles stay internal
  -> safe edits hot-reload quickly
  -> unsafe edits fall back predictably
  -> every decision is explainable
```

The highest-value workflow is kernel tuning:

```text
user edits a .cu or .hip kernel body
  -> classify edit as device-body-only
  -> map edit into generated device role
  -> verify ABI and layout unchanged
  -> compile affected device sidecar only
  -> reload sidecar without restarting host runner
  -> capture post-HMR frame
```

This should be the first serious production slice, but it must be implemented
with ABI gates and build metadata. Regex patching alone is not acceptable.

## 2. Current Baseline

### Proven

The ROCm/GLFW validation is a real milestone:

- entry file: `src/app/main.cpp`
- workspace size: `293` user files
- relevant source mix: `51` `.cpp` / `.hpp` / `.h` / `.hip` files
- GPU target: ROCm `gfx1201`
- render backend: GLFW/OpenGL
- generated roles: `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`,
  `device.hip`
- generated files: internal only
- device reload: succeeded
- runner state: preserved
- screenshots: visible before and after HMR

This proves the mechanism can work end-to-end for one important path.

### Not Yet Proven

The following should be treated as claims requiring matrix validation:

- CUDA production readiness
- large CMake repository support
- multi-target project selection
- multi-device-translation-unit support
- raylib/SFML/ImGui coverage
- Vulkan coverage
- RDC/device-link coverage
- safe reload under ABI-changing edits
- sandboxing of arbitrary native code

Do not write "CUDA works" in production docs unless it is backed by a current
validation report. Use "CUDA path exists" or "CUDA requires matrix validation."

## 3. External Constraints That Shape The Design

Build-system metadata is mandatory. CMake can generate
`compile_commands.json` with exact compiler calls for translation units, but
only for Makefile and Ninja generators, and CMake warns that this does not
work well with Unity builds. That matters because large C++ projects often use
target-specific defines, include roots, generated headers, and build modes.

`compile_commands.json` is necessary but insufficient. The Clang compilation
database spec says each command object describes one way a translation unit is
compiled, and the same file can have multiple command objects for different
configurations. The `arguments` field is preferred over shell-escaped
`command`, because escaping is an error source.

For CMake projects, target discovery should use the CMake File API, not
string-parsing `CMakeLists.txt`. The File API provides semantic build-system
information, including configurations, directories, projects, and targets.

Multi-TU device support must preserve vendor compilation semantics. CUDA
separate device compilation is not the default. NVIDIA documents that
whole-program compilation is still the default, while separate compilation
uses relocatable device code, `--device-c`, and `--device-link`.

HIP has the same class of issue. In non-RDC mode, device code in one
translation unit cannot call device functions in another. With `-fgpu-rdc`,
multiple translation units are linked into device images. ROCm also documents
`-fgpu-rdc` as relocatable device code, or separate compilation mode.

Native runner isolation is not optional. Docker seccomp can restrict system
calls, and cgroups can limit CPU and memory, but neither automatically solves
all GPU runaway or driver-level failure modes. Use them as part of a sandbox,
not as the whole sandbox.

## 4. Production Invariants

These are non-negotiable.

### Invariant 1: User Workspace Purity

Generated files must never appear as normal user files.

Allowed:

- internal generated split viewer
- debug-only generated artifact panel
- downloadable validation artifact bundle
- internal `.synthi` sidecar

Not allowed:

- `core.cpp` in user tree
- `gui.cpp` in user tree
- `host_runner.cpp` in user tree
- `shared.h` in user tree
- `device.cu` / `device.hip` in user tree

### Invariant 2: No Unsafe Fast Path

`device_only` reload is allowed only when all of these are true:

- kernel signatures unchanged
- launch ABI unchanged
- constant/global device symbol layout unchanged
- host-visible state layout unchanged
- device role mapping is valid
- affected generated role compiles
- post-compile symbol verifier passes
- runner reload API accepts the artifact

If any gate fails, fall back to:

- mixed reload
- cold runner restart
- AI delta patch
- full re-split
- unsupported with reason

Never guess.

### Invariant 3: Every Run Has A Reload Plan

Every run should produce a machine-readable reload plan:

```json
{
  "plan": "device_only",
  "reasonCodes": [
    "edit.kernel_body_only",
    "abi.kernel_signature_unchanged",
    "abi.constant_layout_unchanged",
    "build.device_sidecar_only"
  ],
  "fallbacksAvailable": ["ai_delta", "full_resplit", "cold_restart"],
  "affectedUserFiles": ["src/gpu/raster.hip"],
  "affectedGeneratedRoles": ["device.hip"],
  "timingsMs": {
    "classify": 12,
    "patch": 8,
    "compile": 840,
    "reload": 4,
    "firstFrame": 120
  }
}
```

### Invariant 4: Deterministic Context, Not Prompt Truncation

The AI should not receive "whatever fits." It should receive a deterministic,
explainable source graph.

Every included file needs a reason:

- entry translation unit
- target source
- transitive include
- device translation unit
- kernel declaration
- kernel launch site
- render backend
- state type definition
- generated-header prerequisite
- build metadata

Every dropped file needs a reason:

- unrelated target
- vendor dependency
- docs/tests/examples
- generated output
- binary/blob
- prompt-budget exclusion after lower priority ranking

Critical files must not be silently dropped.

## 5. Target Architecture

### First Run

```text
user Run file
  -> resolve build target
  -> collect compile/build metadata
  -> select source context
  -> full AI split
  -> verify generated roles
  -> compile internal roles
  -> launch isolated runner
  -> capture first visible frame
  -> persist sidecar metadata
```

### Repeat Run Without Edits

```text
same target and same source hashes
  -> split cache hit
  -> compile cache hit where possible
  -> runner reuse or fast launch
```

### User Edit After Split

```text
changed user files
  -> classify edit
  -> choose reload plan
  -> local deterministic patch when safe
  -> AI delta patch when local patch cannot prove safety
  -> full re-split only when necessary
```

### Device-Body Edit

```text
changed .cu/.hip file
  -> parse with original compile flags
  -> find mapped kernel/helper span
  -> classify body-only vs ABI/layout/mixed
  -> patch generated device role
  -> verify ABI and constants
  -> compile affected sidecar only
  -> reload
  -> screenshot
```

## 6. Required Sidecar Schema

The current `.synthi_split_meta.json` should become a formal contract, not an
incidental cache file.

### Milestone 1 Required Fields

Milestone 1 should require only:

- `schemaVersion`
- target identity
- source baseline hashes
- generated role paths
- user-to-generated device mappings
- kernel signature hashes
- constant/global layout hashes
- last reload plan report

Reason: otherwise the first slice becomes too large and delays the
highest-value workflow.

### Forward-Compatible Fields

These fields should be allowed but not required for Milestone 1:

- host state layouts
- multi-TU device role list
- CMake codemodel hashes
- device-link graph
- full source context report
- runner isolation metadata

### Minimum Shape

```json
{
  "schemaVersion": "gpu-hmr-meta-v1",
  "project": {
    "workspaceRoot": "...",
    "sourceRoot": "...",
    "buildRoot": "...",
    "entryFile": "src/app/main.cpp"
  },
  "target": {
    "buildSystem": "cmake",
    "targetName": "gpu_app",
    "configuration": "Debug",
    "compiler": "hipcc",
    "languageStandards": {
      "CXX": "20",
      "CUDA": null,
      "HIP": "hip"
    }
  },
  "sourceBaseline": {
    "files": [
      {
        "path": "src/gpu/raster.hip",
        "sha256": "...",
        "role": "device_source",
        "includedBecause": ["target_source", "contains_kernel"]
      }
    ]
  },
  "generatedRoles": {
    "shared": ".synthi/generated/.../shared.h",
    "core": ".synthi/generated/.../core.cpp",
    "gui": ".synthi/generated/.../gui.cpp",
    "hostRunner": ".synthi/generated/.../host_runner.cpp",
    "deviceRoles": [
      {
        "id": "device.raster",
        "path": ".synthi/generated/.../device_raster.hip",
        "sourceFiles": ["src/gpu/raster.hip"],
        "compiler": "hipcc",
        "arch": "gfx1201"
      }
    ]
  },
  "mappings": [
    {
      "kind": "kernel",
      "symbolId": "kernel:shade_pixels(float*,int,int)",
      "userFile": "src/gpu/raster.hip",
      "userRange": {"startByte": 1024, "endByte": 1890},
      "generatedRole": "device.raster",
      "generatedRange": {"startByte": 3400, "endByte": 4266},
      "bodyHash": "...",
      "signatureHash": "...",
      "launchSites": ["src/app/main.cpp:144"]
    }
  ],
  "abi": {
    "kernels": [],
    "deviceGlobals": [],
    "constantSymbols": [],
    "hostStateTypes": [],
    "launchSites": []
  },
  "cacheKeys": {
    "fullSplit": "...",
    "localPatch": "...",
    "deviceCompile": "..."
  },
  "lastReloadPlan": null
}
```

## 7. Reload Plan Classification

Use explicit classes.

### `device_only`

Allowed for:

- kernel arithmetic/body changes
- helper function body changes
- local variable changes
- loop/body tuning
- math intrinsic changes
- comments/formatting in mapped device body

Required gates:

- no signature change
- no launch argument change
- no struct layout change used across host/device boundary
- no constant/global symbol layout change
- no include graph change affecting ABI
- no macro change affecting unmapped generated code
- host module rebuild not required

### `host_only`

Allowed for:

- UI-only code
- camera controls
- CPU-side constants not copied to device layout
- logging
- non-GPU render wrapper behavior

Required gates:

- no device role changes
- no launch ABI changes
- runner state can be preserved or safely patched

### `mixed`

Use for:

- host launch argument changes
- host/device shared type changes
- changes to generated `shared.h` equivalent
- changes touching both render loop and kernel dispatch

### `abi_breaking`

Use for:

- kernel signature changes
- kernel name/linkage changes
- device global or constant symbol layout changes
- host/device struct layout changes
- state layout changes
- RDC/device-link topology changes
- compiler flag or architecture changes

### `unsupported`

Use for:

- macro-generated kernels without stable source mapping
- templates where instantiations cannot be enumerated
- device code generated by external build step not present
- RDC/device-link mode not supported for the project
- unsupported graphics/context ownership
- missing compile metadata
- ambiguous target selection

Do not hide unsupported cases behind vague compile errors.

## 8. Direct User Device Edit Path

This is the recommended next implementation slice.

### Scope For First Version

Keep the first version deliberately narrow:

- single selected build target
- single device translation unit
- CUDA or HIP, one vendor path at a time
- existing generated device role
- mapped `.cu` / `.hip` kernel/helper body-only edits
- no macro-generated kernels
- no signature edits
- no struct layout edits
- no constant/global layout edits
- no host launch edits
- no RDC/device-link topology changes
- one generated device role

This narrow scope is enough to prove the highest-frequency workflow.

### Parsing Is A Hard Safety Gate

Regex may find candidate spans. Regex may not prove safety.

`device_only` requires compiler-compatible parsing with the selected target's
effective flags. If parsing fails, reject `device_only`.

Use compile database flags where available. `compile_commands.json` records the
working directory, command, source file, and can contain multiple commands for
the same file under different configurations. The parser cannot use "some
flags"; it needs the selected target's effective flags.

For CUDA, Clang parsing is a strong tool, but not perfect proof that NVCC
semantics are identical in every edge case. There is no formal CUDA language
spec, and Clang CUDA dialect behavior can differ from NVCC.

For HIP, use the same principle. HIP code must be compiled for a specific AMD
GPU architecture, and `hipcc` invokes `amdclang++` while passing required
options through. Missing flags can change parse results and codegen behavior.

### Fast Path Separation

Direct device path:

- local only
- no AI
- mapped body-only edits only
- must pass parser and ABI verifier

AI delta path:

- used when mapping exists but local patch cannot prove safe
- still verifier-gated

Full re-split:

- last resort

### Algorithm

1. Detect changed files since `sourceBaseline`.
2. Filter changed files to `.cu` / `.cuh` / `.hip` / `.h` / `.hpp` used by the
   device role.
3. Load the original compile command for the owning translation unit.
4. Parse old and new source with the same selected-target flags.
5. Diff AST/symbol spans, not just text.
6. Match changed span to sidecar mapping.
7. Classify edit.
8. If body-only, patch generated device role.
9. Recompute kernel ABI and constant/global symbol metadata.
10. Compile generated device role only.
11. Inspect compiled artifact symbols/layout where possible.
12. Reload sidecar.
13. Capture screenshot or frame readiness signal.
14. Write reload report.

### Rejection Rules

Reject `device_only` when any of these are true:

- edit crosses mapped and unmapped regions
- edit changes function parameters
- edit changes return type
- edit changes function attributes
- edit changes linkage/static/extern visibility
- edit changes template parameters
- edit changes `constexpr` values used in ABI/layout
- edit changes `__constant__` or device global declarations
- edit changes shared host/device struct definition
- edit changes launch grid/block logic in host code
- edit changes included header that affects multiple mapped kernels
- parser cannot build a reliable before/after tree
- required compile metadata is incomplete

### Acceptance Criteria

Arithmetic body edit:

- `reloadPlan = device_only`
- no AI call
- no full AI split
- no host rebuild
- runner survives
- post-HMR frame captured

Signature edit:

- `reloadPlan = abi_breaking`
- `device_only` blocked
- UI/report shows signature hash changed

Launch argument edit:

- `reloadPlan = mixed` or `abi_breaking`
- UI/report shows launch ABI changed

Constant/global edit:

- `reloadPlan = abi_breaking`
- `device_only` blocked
- UI/report shows constant/global layout changed

Parse failure:

- `device_only` rejected
- fallback chosen
- reason code shown

Old sidecar:

- existing flow still works
- `device_only` disabled unless required fields exist

## 9. Build-System Integration

This must graduate from "infer manifest from context" to "derive manifest from
target."

### Inputs

- `compile_commands.json`
- CMake File API codemodel
- CMake cache
- build configuration
- target name
- source file to target mapping
- generated header locations
- compiler identity
- GPU vendor
- GPU architecture
- framework/library link flags

### Target Resolution

The clicked Run file should map to one build target.

Resolution order:

1. explicit target selected by user
2. single executable target containing Run file
3. single target that owns the entry translation unit
4. target inferred from launch/debug config
5. error card if ambiguous

Bad behavior:

- guessing the first executable target
- guessing from file name alone
- silently dropping target-specific defines
- silently ignoring generated headers

### Incomplete Metadata Rule

If compile database or target metadata is incomplete:

- no `device_only` proof
- fallback to AI delta or full re-split
- show missing metadata reason

### Compile Manifest

The split manifest must preserve:

- compiler path
- compiler kind
- language mode
- standard
- include directories
- system include directories
- defines
- undefines
- GPU arch flags
- RDC/device-link flags
- warnings that affect compilation
- source file working directory
- generated header paths
- link libraries
- link directories
- runtime library paths
- framework flags

### Acceptance Criteria

- multi-target CMake project resolves correct app target
- ambiguous target returns actionable UI error
- compile manifest matches target-effective flags
- generated headers are available before split/compile
- Unity build projects are handled explicitly or rejected with reason

## 10. Scalable Source Graph Selection

Large repositories need a context engine.

### Inputs

- resolved target
- compile database entries
- CMake File API target graph
- include graph
- device symbol graph
- kernel launch graph
- render/backend files
- state type definitions
- build metadata

### Selection Tiers

- Tier 0: entry file, selected target metadata, compile flags
- Tier 1: files defining kernels, launch sites, host/device shared types
- Tier 2: transitive headers required to parse Tier 1
- Tier 3: render backend and UI loop files
- Tier 4: local project helpers directly called by Tier 1 and 2
- Tier 5: summarized external/vendor APIs
- Tier 6: omitted docs/tests/examples/unrelated targets/generated blobs

### Determinism Rules

- sort by stable path and dependency distance
- hash every included file
- record inclusion reason
- record omission reason
- hard-fail if required parse dependency is missing
- never silently truncate critical files

### Acceptance Criteria

- 5,000-file repository produces bounded context
- all included files have reasons
- all omitted files have reasons
- same repo state produces same context
- prompt budget overflow produces a structured error or safe summarization

## 11. Multi Device Translation Unit Support

The current one-device-role model will become brittle.

### Required Model

- one generated device role per source device TU where possible
- device headers preserved as internal generated headers
- kernel-to-TU mapping persisted
- per-TU compile cache
- device-link bundle only when project requires RDC
- affected-TU reload when ABI permits
- linked-bundle reload when device-link is required

### CUDA-Specific Handling

Whole-program device mode:

- compile affected generated `.cu` role when isolated

RDC mode:

- compile affected role with relocatable device code
- run device-link step for required bundle
- reload linked artifact

Unsupported:

- explain which device-link mode is not handled

### HIP-Specific Handling

`-fno-gpu-rdc`:

- affected TU must be self-contained for device calls

`-fgpu-rdc`:

- compile affected bitcode/object
- relink device image/fat binary as needed
- reload affected bundle

### Acceptance Criteria

- multiple user `.cu` / `.hip` files do not flatten into one generated file
- editing one kernel body recompiles only the affected TU when safe
- RDC projects have explicit device-link behavior
- unsupported device-link cases fall back clearly

## 12. ABI And State Verifier

The verifier is the safety core.

### Track Before And After Every Edit

- kernel name
- kernel mangled name
- kernel parameters
- parameter sizes and alignment
- launch argument order
- device global symbols
- constant symbols
- host/device shared struct layouts
- state object layouts
- generated shared header hash
- compiler flags affecting ABI
- GPU architecture
- RDC/device-link mode

CUDA variable specifiers such as `__device__`, `__constant__`, `__managed__`,
and `__shared__` affect memory placement, so constant and device-global
declarations must be treated as ABI/layout inputs, not ordinary body text.

### Verifier Output

```json
{
  "verdict": "reject_device_only",
  "rule": "abi.kernel_signature_changed",
  "before": "shade_pixels(float*, int, int)",
  "after": "shade_pixels(float*, int, int, float)",
  "safeFallback": "mixed_or_full_resplit"
}
```

### Verifier Artifacts

For every rejected fast path, save the before/after evidence:

- before signature hash
- after signature hash
- before constant/global layout hash
- after constant/global layout hash
- changed user span
- mapped generated span
- parser status
- rejection rule
- chosen fallback

This prevents "the system refused HMR" from becoming another opaque failure
mode.

### Acceptance Criteria

- ABI-breaking edit cannot enter `device_only` path
- constant layout change cannot enter `device_only` path
- state layout change causes cold reload or state migration
- runner state is preserved only when verifier allows it

## 13. Failure UX

Engineers need immediate cause, not raw logs.

### Error Card Categories

- `target_resolution_failed`
- `compile_database_missing`
- `generated_header_missing`
- `include_not_found`
- `library_not_found`
- `gpu_arch_missing`
- `vendor_toolchain_missing`
- `split_verifier_failed`
- `mapping_missing`
- `abi_changed`
- `constant_layout_changed`
- `device_compile_failed`
- `device_link_failed`
- `reload_failed`
- `runner_crashed`
- `screenshot_not_ready`
- `unsupported_project_shape`

### Error Card Format

```text
Problem:
  Device-only reload rejected.

Reason:
  Kernel signature changed.

Changed symbol:
  shade_pixels(float*, int, int) -> shade_pixels(float*, int, int, float)

Chosen fallback:
  mixed rebuild required.

Next action:
  Re-run with host launch site update, or revert signature change.
```

Bad error:

```text
Build failed.
```

## 14. Generated Artifact Lifecycle

### Internal Artifacts

- generated roles
- compile manifests
- source mapping
- ABI snapshots
- device sidecars
- linked bundles
- screenshots
- run reports
- logs

### Required Provenance

- source file hashes
- target name
- build configuration
- compiler identity
- GPU vendor and arch
- model name
- split schema version
- prompt schema version
- generated timestamp
- parent run id
- cache key

### Debug Viewer

Provide a read-only internal viewer:

- generated role files
- user-to-generated mapping
- compile command per role
- ABI snapshot
- reload plan
- cache hit/miss reason
- validation screenshots

Do not expose generated roles as normal editable workspace files.

## 15. Performance And Caching

### Cache Keys

Use more than source text:

- target name
- configuration
- compiler path/version
- language standard
- include dirs
- defines
- GPU arch
- RDC/device-link mode
- framework flags
- source graph hashes
- split schema version
- model/version
- prompt schema version

### Fast Path Targets

Repeat run unchanged:

- no AI split

Small deterministic host/device value edit:

- local patch

Body-only kernel edit:

- direct device patch and sidecar compile

Unsafe mapped edit:

- AI delta patch

Mapping failure or major structural edit:

- full re-split

### Required Logs

- cache hit/miss
- miss reason
- compile invalidation reason
- AI call reason
- patch tier used
- reload plan
- time per phase
- first-frame time

## 16. Safety And Isolation

The runner executes arbitrary native code. Treat it as hostile.

Requirements:

- separate supervisor and runner process
- no unsafe in-process runner in product mode
- per-session process group
- CPU and memory limits
- wall-clock timeout
- GPU visibility restrictions where supported
- filesystem isolation
- network policy
- seccomp/AppArmor profile where supported
- crash containment
- artifact cleanup
- explicit unsafe/debug mode

GPU runaway handling is harder than CPU process killing. Product behavior
should be conservative:

- timeout kernel execution where API allows
- kill runner process on suspected runaway
- reset session state after GPU fault
- surface driver/device fault clearly
- avoid claiming guaranteed per-kernel kill across vendors

## 17. Observability

Every run should emit one structured report.

### Minimum Trace Fields

- runId
- workspaceId
- entryFile
- selectedTarget
- targetResolutionMethod
- sourceContextFiles
- omittedFiles
- compileDbHash
- cmakeCodemodelHash
- gpuVendor
- gpuArch
- model
- splitSchemaVersion
- promptSchemaVersion
- splitCacheKey
- splitCacheHit
- patchTier
- reloadPlan
- generatedRoles
- compileCommands
- deviceLinkCommands
- verifierRules
- reloadTimings
- screenshotTimings
- runnerPid
- runnerExitStatus
- crashMarkers
- artifactPaths

### UI Summary

```text
Run mode:
  device_only

Why:
  kernel body edit, ABI unchanged, constant layout unchanged

Rebuilt:
  device_raster.hip only

Skipped:
  full AI split, host rebuild, runner restart

Time:
  classify 12 ms, compile 840 ms, reload 4 ms, frame 120 ms
```

## 18. Validation Matrix

### Must-Pass Matrix

- CUDA + SDL2
- CUDA + GLFW/OpenGL
- ROCm + SDL2
- ROCm + GLFW/OpenGL
- raylib
- SFML
- ImGui + SDL2
- ImGui + GLFW
- OpenGL context edge cases
- Vulkan unsupported or explicit fallback

Vulkan is not in the same bucket as SDL2/GLFW/OpenGL. Vulkan is unsupported
for GPU HMR unless context, swapchain, pipeline, descriptor, and
synchronization ownership are modeled. The current requirement is explicit
fallback or unsupported error, not a near-term HMR claim.

### Per-Case Assertions

- first compile succeeds
- first screenshot visible and non-black
- generated files absent from user tree
- device body edit detected
- reload plan recorded
- device-only compile used when safe
- post-HMR screenshot visible and materially changed
- runner survives device-only reload
- cache report produced
- failure card produced for forced bad edit

### Validation Artifact Bundle

- run report
- source context report
- compile manifest
- generated manifest
- reload plan
- before/after screenshots
- stdout/stderr
- verifier report
- cache report
- runner survival marker

## 19. Backward Compatibility

Backward compatibility is required.

Implementation rules:

- read old sidecar shape
- write new sidecar shape
- migrate known fields opportunistically
- if required new fields are missing, do not fail existing run
- if required new fields are missing, disable unsafe fast path
- fall back to AI delta or full re-split

This avoids breaking current ROCm/GLFW validation and existing cached splits.

## 20. Revised Roadmap

### Milestone 0: Contracts And Instrumentation

Do this before more feature work.

Tasks:

- formalize `.synthi_split_meta.json`
- formalize reload plan schema
- add reason-coded verifier output
- add run report
- show reload plan in UI/logs
- show fast path used
- show cache hit/miss reason
- preserve old sidecar compatibility

Done when:

- an engineer can explain every run without reading raw container logs

### Milestone 1: Direct User Device-Body Edit Path

Tasks:

- persist kernel/helper source mappings
- classify body-only edits
- patch generated device role locally
- verify kernel signatures
- verify constants/device globals
- compile device sidecar only
- reload sidecar
- capture screenshot
- emit verifier artifacts and reload report

Initial scope:

- single device TU
- single generated device role
- no macro-generated kernels
- no signature/layout edits
- no host launch edits
- no RDC/device-link changes
- one vendor path first

Done when:

- editing a mapped kernel arithmetic expression in user `.cu` / `.hip` avoids
  AI split, avoids AI delta, avoids host rebuild, and produces a visible
  post-HMR frame

### Milestone 2: Build Target Integration

Tasks:

- parse `compile_commands.json`
- query CMake File API
- resolve Run file to target
- preserve target compile flags
- preserve link flags
- detect generated headers
- surface ambiguity

Done when:

- a nontrivial multi-target CMake GPU app builds without guessed flags

### Milestone 3: Large Repo Context Engine

Tasks:

- build include/source graph
- rank files deterministically
- include device/render/state/build metadata
- exclude unrelated/vendor/generated content
- log included and omitted files

Done when:

- a 5,000-file repo produces bounded, reproducible, explainable context

### Milestone 4: Multi Device TU

Tasks:

- extend manifest for multiple device roles
- support per-TU compile
- support CUDA device-link where required
- support HIP `-fgpu-rdc` where required
- map kernels to TUs
- reload affected sidecars or linked bundles

Done when:

- projects with multiple `.cu` / `.hip` files use HMR without forced
  flattening

### Milestone 5: Failure UX And Artifact Viewer

Tasks:

- add categorized error cards
- add generated split viewer
- add mapping viewer
- add manifest viewer
- add compile command viewer
- add verifier report panel

Done when:

- failures are actionable without raw logs

### Milestone 6: Vendor/Framework Matrix

Tasks:

- add validation fixtures
- run first compile and device-only HMR
- assert screenshots
- assert user tree purity
- assert reload plan
- assert runner survival
- publish current reports

Done when:

- every claimed backend has a current passing report

### Milestone 7: Product Isolation

Tasks:

- separate runner process
- add CPU/memory/time limits
- add filesystem isolation
- add seccomp/AppArmor where available
- add crash cleanup
- separate unsafe debug mode

Done when:

- a crashing or hostile runner cannot corrupt the supervisor

## 21. Updated Definition Of Production Ready

GPU HMR is production-grade only when all are true:

1. Runs start from real build targets, not guessed files.
2. Target compile flags and link flags are preserved.
3. Large repos use deterministic source graph selection.
4. User `.cu` / `.hip` body edits use direct device-only HMR.
5. ABI-breaking edits are blocked before unsafe reload.
6. Multi-device-TU projects are supported or clearly rejected.
7. Generated roles remain internal and inspectable.
8. Every run shows which fast path was used.
9. CUDA and ROCm pass the supported framework matrix.
10. Failures are categorized and actionable.
11. Native runner crashes are isolated.
12. Validation reports are reproducible and current.

## 22. Recommended Immediate Task

Implement this vertical slice:

```text
user edits src/gpu/*.hip or src/gpu/*.cu
  -> detect changed mapped kernel body
  -> classify body-only
  -> patch generated device role
  -> verify signature and constant/global layout
  -> compile device sidecar only
  -> reload sidecar
  -> capture screenshot
  -> emit reload report
```

Do not start with multi-TU or full CMake generality. Start with one target and
one device TU, but build the metadata and verifier as if multi-TU will arrive
next. That avoids a rewrite later.
