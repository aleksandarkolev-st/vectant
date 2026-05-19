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

- warm deterministic rebuild/relink
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
  "fallbacksAvailable": ["warm_rebuild", "ai_delta", "full_resplit", "cold_restart"],
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

### Invariant 5: Agentic Output Is Never Trusted Directly

Every AI split, AI delta, or AI repair must pass deterministic verification
before:

- writing sidecar state
- enabling `device_only`
- reloading the runner
- marking validation as passed

The agent may propose or repair generated artifacts. Parser, ABI, compile,
artifact, and runtime verifiers decide whether the output is accepted.

## 5. Target Architecture

### First Run

```text
resolve build target
  -> collect build metadata
  -> resolve toolchain capability profile
  -> select deterministic source context
  -> agentic split/verify loop
  -> arbiter accepts or rejects ranked execution option
  -> compile generated roles
  -> runtime verification
  -> persist sidecar only if verified
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
  -> local classifier
  -> direct deterministic patch if provably safe
  -> warm deterministic rebuild/relink if proof is safe but patch is not local
  -> otherwise agentic delta/verify loop
  -> arbiter ranks safe options and applies consent policy
  -> compile
  -> verifier gates
  -> reload
```

### Full Re-Split Fallback

```text
mapping failed or structural edit
  -> agentic full re-split
  -> verifier loop
  -> compile
  -> runtime proof
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

Direct `device_only` remains non-agentic for the fast path. It uses local
mapping and deterministic verification. AI only enters when local proof fails.

Warm rebuild/relink is the middle path. It is deterministic and non-agentic,
but broader than a local generated-span patch. Use it when the edit is safe
only after rebuilding an affected host/device role, relinking a sidecar, or
restarting a narrow part of the runner without performing a full AI re-split.

### Runtime Reload ABI

Reloading a sidecar without restarting the host runner requires a deterministic
runtime ABI. It cannot rely on stale function pointers or ad hoc
`dlsym`/`GetProcAddress` calls spread across generated host code.

Required model:

- all generated launch sites call through a Global Launch Indirection Table
- the table is keyed by stable kernel/launch symbol ids
- only the loader owns `dlsym`, `GetProcAddress`, or vendor module lookup
- reload swaps table entries atomically after compile and verifier gates pass
- old artifacts stay alive until no in-flight launch can reference them
- every launch wrapper records artifact generation/version
- mapping verifier rejects launch sites that bypass the indirection table

If any generated role caches a direct launch-wrapper pointer, the runner can
enter a split-brain state where old and new kernels run together. That must be
treated as:

```text
reload_failed.stale_launch_pointer
```

The AI may patch generated source roles to use the dispatch table. It must not
patch compiled binaries or certify that runtime pointer redirection is safe.

## 6. Agentic Split/Verify Orchestrator

The AI split is not a one-shot generation step. It is a bounded
propose-verify-repair loop over internal generated artifacts.

This is not a separate product feature. It sits inside the existing pipeline
and owns every AI-generated transformation path:

- first full split
- full re-split fallback
- AI delta patch
- generated-role compile repair
- generated mapping proposal

The direct device-body fast path is outside the agentic path when local proof
succeeds.

### Canonical Loop

1. Planner reads target metadata and source context.
2. Splitter proposes generated roles.
3. Static verifier checks schema, mappings, ABI metadata, and role boundaries.
4. Build verifier compiles host/device artifacts.
5. Runtime verifier launches the runner and captures a frame.
6. Repair agent patches generated roles if a verifier fails.
7. Bounded retry.
8. Persist only after all required gates pass.

The agent may propose. Deterministic verifiers decide.

### Actors And Authority

Proposal and repair actors:

- Split Agent: produces `shared`, `core`, `gui`, `host_runner`, and device roles
- Mapping Agent: proposes user-to-generated symbol/span mappings
- Compile Repair Agent: fixes generated-role compile failures only
- Delta Patch Agent: patches generated roles after user edits when local
  patching cannot prove safety. It must use the split architecture overview,
  generated role manifest, user delta, user-to-generated mappings, current
  generated role contents, compile manifest, reload plan, and verifier/build
  feedback to choose the affected generated module or modules.
- Template Triage Agent: reads compiler-derived template evidence, mappings,
  include graph, generated roles, compiler errors, prior verifier failures, and
  architecture summary. It may propose `warm_rebuild`, `ai_delta`,
  `full_resplit`, or `unsupported`. It cannot certify `device_only` safety,
  ABI safety, layout safety, or complete instantiation coverage.

Deterministic pipeline components:

- Build Metadata Reader: consumes `compile_commands.json` and CMake File API
  replies
- Context Planner: selects source files and records inclusion/omission reasons
- Template Evidence Collector: collects compiler-derived template impact
  evidence for device-reachable code outside the hot edit path
- Verifier Orchestrator: runs schema, mapping, ABI, compile, artifact, and
  runtime/frame verifiers
- Reload Planner: chooses `device_only`, `host_only`, `warm_rebuild`, `mixed`,
  `abi_breaking`, `full_resplit`, or `unsupported`
- Arbiter / Policy Engine: ranks verified options and chooses auto-run, skip,
  fallback, or ask-developer
- Artifact Inspector: checks generated files, symbols, reports, screenshots,
  and runner state

Do not use "Verifier Agent" as an authority name. The verifier is an
orchestrator for deterministic checks. The LLM can explain or repair failures;
it cannot certify safety.

### Agent Permissions

The agent may:

- propose generated roles
- propose mappings
- repair generated-role compile failures
- produce AI delta patches
- propose template edit routing based on compiler-derived evidence
- explain verifier failures

The agent may not:

- certify ABI safety
- certify template impact or complete instantiation coverage
- bypass parser failures
- bypass compile failures
- write generated roles into the user workspace
- silently fall back to full re-split
- mutate user source

### AI Delta Is Architecture-Aware Generated-Module Patching

AI delta is not generic text replacement and not a mechanical replay of the
user edit. It is an architecture-aware patch over internal generated roles.

The delta agent receives:

- architectural overview of the split
- generated role manifest
- user-to-generated symbol/span mappings
- changed user delta
- current generated role contents and hashes
- compile manifest and device-link metadata
- current reload plan attempt
- verifier/build/runtime failure feedback

It may patch `device`, `shared`, `core`, `gui`, `host_runner`, or multiple
roles when the architectural delta requires it. The accepted patch is still
decided by deterministic schema, mapping, ABI, compile, artifact, and runtime
verifiers.

### Agentic Output Is Never Trusted Directly

Every AI split, AI delta, or AI repair must pass deterministic verification
before:

- writing sidecar state
- enabling `device_only`
- reloading the runner
- marking validation as passed

This is critical. Otherwise the agent can hallucinate a valid split.

### Arbiter And Policy Engine

The Arbiter sits after AI proposals, local classifiers, reload planning, and
deterministic verifier output. It answers a different question from the
verifiers:

```text
Verifiers decide: is this option safe and valid?
Arbiter decides: is this safe option worth running now?
```

The Arbiter is deterministic and cost-aware. It may use prior run history and
toolchain capability profiles, but it must not be an LLM-only judgment.

Inputs:

- ranked reload options from the Reload Planner
- deterministic verifier verdicts and reason codes
- toolchain capability profile
- expected and observed latency by tier
- device-link and RDC requirements
- runner state preservation or loss
- launch indirection and stale-pointer checks
- warm path budget result
- memory arena and VRAM refresh state
- GPU driver/device taint state
- prior success/failure for the same project/toolchain

Outputs:

```json
{
  "arbiterDecision": "auto_run",
  "selectedPlan": "device_only",
  "reasonCodes": [
    "arbiter.safe",
    "arbiter.under_latency_budget",
    "arbiter.no_state_loss"
  ],
  "rankedOptions": [
    {
      "plan": "device_only",
      "safety": "pass",
      "estimatedMs": 850,
      "stateLoss": false,
      "requiresConsent": false
    }
  ]
}
```

Allowed decisions:

- `auto_run`
- `ask_developer`
- `skip`
- `fallback`
- `unsupported`

Developer consent is required for:

- cold runner restart
- full AI re-split
- AI delta touching multiple generated roles
- linker-bound or over-budget warm path
- state migration or state loss
- unsafe/debug mode
- experimental toolchain capability
- GPU device/session tainted by driver fault

Auto-run is allowed only when:

- deterministic verifiers pass
- estimated latency is within tier budget
- no runner state is lost
- no stale launch-pointer risk exists
- no developer consent rule is triggered

The Arbiter never overrides a verifier failure.

### Build Metadata Dependency

The agentic splitter must consume real target metadata before it sees source.
Do not let it infer flags from code.

`compile_commands.json` can contain multiple command objects for the same file
under different configurations, so the selected target/config must be
explicit. The `arguments` form is safer than shell-parsed `command`.

For CMake, use File API replies for semantic target/build-system data instead
of scraping `CMakeLists.txt`. CMake documents the File API as the interface for
clients to get semantic build-system information.

### Device Compilation Dependency

The verifier must know when generated device roles require device linking.

CUDA separate compilation/device linking is a real compilation mode, not a
cosmetic flag. NVIDIA documents separate compilation as the ability to link
device code and symbols from different compilation units.

HIP has the same issue. In RDC mode, HIP compilation units contribute
relocatable device code and require a later device-link step into GPU images.

The agentic splitter must emit:

- device role list
- per-role compiler command
- RDC/device-link requirement
- affected device-link bundle
- reload granularity

If it cannot model that, it must return:

```text
unsupported.device_link_topology_unmodeled
```

### CPU HMR Boundary

This layer changes the AI split and AI delta contract for GPU HMR: AI output
becomes proposal/repair output that must pass deterministic verification.

If CPU HMR shares the same split/delta engine, the shared orchestration
contract should be updated once and reused. CPU HMR does not need GPU-specific
ABI, constant memory, device-link, or GPU frame gates. It should get the same
general invariant:

```text
AI proposes generated artifacts or deltas
  -> deterministic CPU/build/runtime verifiers decide
  -> accepted output is persisted or reloaded
```

So updating GPU HMR does not require a full CPU HMR rewrite, but shared
split/delta abstractions should not keep accepting one-shot AI output without
verifier gates.

### Hard Limits

- max full split attempts: 2 or 3
- max repair attempts per failure class: 1 or 2
- no infinite repair loops
- no repair of user source without explicit user action
- no generated artifact accepted after failed verifier

## 7. Required Sidecar Schema

The current `.synthi_split_meta.json` should become a formal contract, not an
incidental cache file.

### Milestone 1 Required Fields

Milestone 1 should require only:

- `schemaVersion`
- target identity
- selected compile command identity and effective flags hash
- toolchain capability profile
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
- global device symbol table hash
- header dependency graph hash
- template evidence store hash
- template instantiation evidence
- template artifact fingerprints
- launch indirection table version
- reload generation count
- arbiter decision history
- full source context report
- runner isolation metadata
- runtime memory arena statistics
- GPU driver fault markers

### Milestone 0.5 Agentic Fields

The sidecar should record the accepted agentic loop result without storing raw
production prompts by default. Store prompt hashes, model, schema version,
source file list, and verifier results. Raw prompt capture should be
debug-only because it may contain proprietary source.

Minimum agentic summary:

```json
{
  "agentic": {
    "splitAttemptCount": 2,
    "repairAttemptCount": 1,
    "lastAgenticMode": "full_split",
    "verifierResults": [
      {
        "rule": "generated.no_user_tree_pollution",
        "status": "pass"
      },
      {
        "rule": "compile.device_role",
        "status": "pass"
      }
    ],
    "finalAcceptedAttempt": "attempt-002"
  }
}
```

### Toolchain Capability Profile

Every reload decision must be backed by a selected toolchain capability
profile. The profile is derived from compile metadata, vendor/toolchain probes,
and measured history for the selected target/configuration.

Minimum profile:

```json
{
  "toolchainCapabilities": {
    "compilerId": "hipcc",
    "compilerVersion": "...",
    "gpuVendor": "rocm",
    "gpuArch": "gfx1201",
    "requiresRdc": false,
    "supportsDeviceOnlyReload": true,
    "supportsIncrementalDeviceLink": false,
    "supportsSymbolInspection": true,
    "supportsSafeModuleUnload": true,
    "supportsGpuTimeoutDetection": "partial",
    "deviceLinkAverageMs": null,
    "deviceLinkP95Ms": null,
    "lastProbeRunId": "..."
  }
}
```

If the capability profile is missing or stale, the Arbiter must not select
`device_only` or `warm_rebuild`; it must choose fallback or ask the developer
with a reason code.

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
  "agentic": {
    "splitAttemptCount": 2,
    "repairAttemptCount": 1,
    "lastAgenticMode": "full_split",
    "verifierResults": [
      {
        "rule": "generated.no_user_tree_pollution",
        "status": "pass"
      },
      {
        "rule": "compile.device_role",
        "status": "pass"
      }
    ],
    "finalAcceptedAttempt": "attempt-002"
  },
  "lastReloadPlan": null
}
```

## 8. Reload Plan Classification

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

### `warm_rebuild`

Use for:

- device-reachable header/helper edits with bounded affected roles
- template body edits with known affected instantiations
- safe host/device role rebuilds that do not require AI re-split
- sidecar relink when device-link topology is known and ABI is unchanged

Required gates:

- affected source/include graph is bounded
- affected generated roles are known
- template instantiation set is known or safely bounded
- vendor compiler artifact checks pass
- runner can reload or narrowly restart the affected artifact

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

## 9. Direct User Device Edit Path

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

### Header And Template Dependency Reality

The fast path must assume large GPU projects are header-heavy. Kernels are often
built from inline helpers, templates, `.cuh` files, and shared `.hpp` headers,
not only from a single `.cu` or `.hip` body.

Header edits are eligible for `device_only` only when the system can prove all
of these:

- the changed header is in the selected target's device include graph
- every affected kernel/helper mapping is known
- every affected generated role is known
- every relevant template instantiation is known or safely bounded
- signature, launch ABI, constant/global layout, and shared struct layout are
  unchanged after recompilation
- vendor compiler artifact checks pass

If the dependency ripple cannot be bounded, reject the direct fast path. Choose
one of:

- warm deterministic rebuild/relink of affected roles
- AI delta/verify loop
- full re-split
- unsupported with a specific dependency reason

Template-heavy code such as Thrust, CUTLASS-style kernels, or project-local
template metaprogramming needs explicit instantiation evidence. The AI may help
explain or repair generated artifacts, but it may not guess which template
instantiations are ABI-relevant.

Template edits are not Tier 0 by default. If a template body, constexpr used by
a template, template parameter, specialization, concept, trait, or vendor
template wrapper is touched, reject `device_only` unless the system can prove
the edit is equivalent to an already-mapped non-template body change. The normal
candidate is `warm_rebuild` only when the Template Evidence Collector has fresh,
bounded evidence for all affected instantiations and generated roles.

### Fast Path Separation

Direct device path:

- local only
- no AI
- mapped body-only edits only
- must pass parser and ABI verifier

AI delta path:

- used when mapping exists but local patch cannot prove safe
- architecture-aware patching of generated role modules
- still verifier-gated

Warm deterministic path:

- no AI
- used when a local span patch is insufficient but the affected rebuild/relink
  set is known
- may rebuild affected generated host/device roles or relink a sidecar
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
- header dependency impact cannot be bounded
- template instantiations cannot be enumerated or safely bounded
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

## 10. Build-System Integration

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

## 11. Scalable Source Graph Selection

Large repositories need a context engine.

### Inputs

- resolved target
- compile database entries
- CMake File API target graph
- include graph
- device symbol graph
- global device symbol table
- template instantiation graph where available
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
- header dependency edits produce a bounded affected-file/affected-role report
- template-heavy edits are either backed by instantiation evidence or rejected
  from the direct fast path

## 12. Template Evidence Collector

This is a hard subsystem, not a note under warm rebuild.

Purpose:

```text
compiler-derived template impact evidence for device-reachable code
```

The collector exists because AI cannot safely infer Thrust, CUTLASS, or
project-local template blast radius from an architecture overview. It should
run outside the hot edit path:

- background indexing
- first split
- warm cache refresh
- explicit rebuild

It must not perform unbounded template analysis during the edit loop.

Inputs:

- selected compile command
- effective flags hash
- include graph
- device source graph
- generated role mappings
- Clang/LibTooling AST evidence
- vendor compiler depfiles
- vendor compiler artifacts
- symbol inspection
- device-link metadata

Outputs:

- affected template instantiations
- affected generated roles
- source-level fingerprints
- artifact-level fingerprints
- ABI/layout fingerprints
- invalidation reasons

Authority:

- may bound template impact when compiler-derived evidence is fresh
- may reject stale or missing evidence
- may not be replaced by RAG or LLM judgment
- may not certify runtime reload safety by itself

Minimum evidence shape:

```json
{
  "templateEvidence": {
    "schemaVersion": "template-evidence-v1",
    "producer": "clang-libtooling+vendor-artifacts",
    "compileCommandHash": "...",
    "effectiveFlagsHash": "...",
    "gpuArch": "gfx1201",
    "entries": [
      {
        "templateName": "BlockReduce<T, BLOCK_SIZE>",
        "templateArgs": ["float", "256"],
        "owningTU": "src/gpu/reduce.cu",
        "instantiationSite": "src/gpu/reduce.cuh:88",
        "reachableFromKernel": "reduce_kernel(float*, float*)",
        "changedInputs": ["BLOCK_SIZE"],
        "sourceHeaders": ["src/gpu/reduce.cuh"],
        "generatedRole": "device.reduce",
        "abiFingerprint": "...",
        "layoutFingerprint": "...",
        "artifactFingerprint": "..."
      }
    ]
  }
}
```

### Template Triage Agent

The Template Triage Agent is useful for routing and explanation, not proof.

Reads:

- template evidence
- mappings
- include graph
- generated roles
- compiler errors
- prior verifier failures
- architecture summary

Proposes:

- `warm_rebuild`
- `ai_delta`
- `full_resplit`
- `unsupported`

Cannot certify:

- `device_only` safety
- ABI safety
- layout safety
- complete instantiation coverage

### Template Edit Policy

Use this classification:

```text
mapped kernel body edit
  -> Tier 0 device_only
  -> no AI

project-local non-template helper body edit
  -> Tier 0 or Tier 1

project-local template body edit
  -> Tier 1 warm_rebuild only if affected instantiations are known

constexpr/template parameter edit
  -> reject device_only
  -> Tier 1 only if all affected instantiations and ABI/layout effects are bounded

Thrust/CUTLASS vendor header edit
  -> unsupported for HMR
  -> normal build or full re-split, with consent

CUTLASS/Thrust wrapper parameter edit
  -> warm_rebuild if affected generated roles and artifacts are bounded
  -> otherwise AI delta or full re-split

unbounded template ripple
  -> template_instantiation_unbounded
  -> no fake HMR
```

### Collector Acceptance Criteria

- project-local `.cuh` fixture records two explicit instantiations
- arithmetic-only constexpr can use bounded `warm_rebuild`
- layout-controlling constexpr is rejected as ABI/layout affecting
- stale template evidence blocks `warm_rebuild`
- vendor template header edits are rejected with vendor boundary reason codes
- Template Triage Agent can propose a candidate path but cannot mark it safe

## 13. Multi Device Translation Unit Support

The current one-device-role model will become brittle.

### Required Model

- one generated device role per source device TU where possible
- device headers preserved as internal generated headers
- kernel-to-TU mapping persisted
- global device symbol table across device TUs
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
- resolve missing device symbols through the global device symbol table
- reload linked artifact

Unsupported:

- explain which device-link mode is not handled

### HIP-Specific Handling

`-fno-gpu-rdc`:

- affected TU must be self-contained for device calls

`-fgpu-rdc`:

- compile affected bitcode/object
- relink device image/fat binary as needed
- resolve missing device symbols through the global device symbol table
- reload affected bundle

### Device-Link Repair Scope

RDC/device-link failures are dependency failures, not ordinary syntax errors.
When `nvlink`, HIP device linking, or vendor link steps fail because a symbol is
missing from another translation unit, the repair loop needs a global symbol
table to identify the owner TU, required include, declaration, or bundle
membership.

If the system cannot map the missing device symbol to a source TU and generated
role, return:

```text
unsupported.device_link_symbol_unresolved
```

Do not let the repair agent guess cross-TU ownership.

### Acceptance Criteria

- multiple user `.cu` / `.hip` files do not flatten into one generated file
- editing one kernel body recompiles only the affected TU when safe
- RDC projects have explicit device-link behavior
- device-link failures include missing symbol, owner TU, and fallback reason
- unsupported device-link cases fall back clearly

## 14. ABI And State Verifier

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

### Native Compiler Is The Final Authority

Clang parsing is useful for source classification, but it is not enough to
certify CUDA safety. NVCC has dialect details, proprietary attributes and
macros such as `__launch_bounds__`, and template-instantiation behavior that
can differ from Clang.

For CUDA, a Clang AST match is only a candidate proof. `device_only` acceptance
must be backed by the actual selected vendor compiler path where possible:

- NVCC compile for CUDA projects
- `hipcc`/`amdclang++` compile for HIP projects
- emitted symbol/mangled-name comparison
- constant/global symbol inspection
- parameter size/alignment comparison
- device-link result when RDC is enabled

If the source parser says "safe" but the vendor compiler artifact does not
confirm the same ABI/layout facts, reject `device_only` and choose a fallback.
This avoids false positive safety matches that can crash the runner.

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

## 15. Failure UX

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
- `header_dependency_unbounded`
- `template_instantiation_bounded`
- `template_instantiation_unbounded`
- `template_evidence_missing`
- `template_evidence_stale`
- `template_artifact_fingerprint_changed`
- `constexpr_affects_layout`
- `constexpr_affects_launch_abi`
- `vendor_template_boundary`
- `template_vendor_boundary_crossed`
- `vendor_template_edit_unsupported`
- `warm_rebuild_budget_exceeded`
- `toolchain_capability_missing`
- `toolchain_capability_stale`
- `arbiter_user_consent_required`
- `arbiter_path_not_worth_running`
- `state_loss_requires_consent`
- `multi_role_ai_delta_requires_consent`
- `experimental_path_requires_consent`
- `device_compile_failed`
- `device_link_failed`
- `device_link_symbol_unresolved`
- `device_linker_bound`
- `incremental_device_link_unsupported`
- `vram_fragmented`
- `vram_session_refresh_required`
- `reload_failed`
- `stale_launch_pointer_detected`
- `runner_crashed`
- `gpu_driver_tdr`
- `gpu_device_tainted`
- `screenshot_not_ready`
- `platform_isolation_unsupported`
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

## 16. Generated Artifact Lifecycle

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
- accepted agentic attempt id
- selected toolchain capability profile hash
- arbiter decision and ranked options
- template evidence hash and invalidation reasons
- verifier results
- launch indirection table version
- warm path budget result
- device-link budget result
- reload generation and memory arena summary
- GPU driver fault markers
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

## 17. Performance And Caching

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

Header/template edit with bounded impact:

- warm deterministic rebuild/relink of affected roles

Unsafe mapped edit:

- agentic AI delta/verify loop

Mapping failure or major structural edit:

- agentic full re-split

### HMR Tiers

Use explicit tiers so latency ownership is clear.

Tier 0: `device_only`

- no AI
- no host rebuild
- local generated-device patch or known device sidecar compile
- target: under 1 second where toolchain allows

Tier 1: `warm_rebuild`

- no AI
- cached dependency graph only
- bounded role rebuild/relink
- target: 1-5 seconds

Tier 2: `ai_delta`

- architecture-aware generated-role patching
- deterministic verifiers decide acceptance
- occasional fallback, not normal edit loop

Tier 3: `full_resplit`

- heavy fallback
- not a hot path
- requires Arbiter justification and developer consent unless explicitly
  configured otherwise

Agentic HMR does not mean AI on every edit. AI is available for split, repair,
explanation, and hard deltas; the Arbiter keeps the hot path deterministic and
cheap.

### Warm Path Performance Budget

The warm path only helps if dependency impact is already available from cached
metadata. It must not rediscover template instantiations by reparsing half the
project on the critical path.

Default budgets:

- impact analysis target: under 250 ms
- impact analysis hard cap: 1,000 ms
- single affected role rebuild/relink target: under 2 seconds
- warm path soft cap: 5 seconds

Inputs should come from persisted compile metadata, depfiles, include graphs,
source mappings, generated-role manifests, global device symbol tables, and the
Template Evidence Collector. The warm path may validate cache freshness, but it
should not perform unbounded project-wide analysis during an edit loop.

If the predicted or observed warm path exceeds the budget, report:

```text
warm_rebuild_budget_exceeded
```

Then choose a clear fallback: standard incremental build, AI delta/verify, full
re-split, or cold restart. Do not present a 5-10 second dependency search as
instant HMR.

### Device-Link Cost Control

RDC warm paths can be linker-bound. A global device symbol table helps explain
dependencies and repair generated artifacts, but it does not make `nvlink` or
HIP device-link fast.

The toolchain capability profile must track:

- whether RDC is required
- whether incremental device linking is supported
- device-link average and p95 latency
- affected bundle size
- cached object reuse rate
- last device-link elapsed time

If device-link is required and the expected linker time exceeds the warm path
budget, the Arbiter must report:

```text
device_linker_bound
```

Then it must ask the developer, choose standard incremental build, or fall back
according to policy. Do not market linker-bound RDC rebuilds as HMR.

### Required Logs

- cache hit/miss
- miss reason
- compile invalidation reason
- header dependency invalidation reason
- template instantiation invalidation reason
- template evidence cache hit/miss/stale reason
- warm path estimate and actual elapsed time
- warm path budget result
- device-link estimate and actual elapsed time
- device-link budget result
- AI call reason
- agentic mode and attempt count
- verifier failure reason codes
- patch tier used
- reload plan
- time per phase
- first-frame time

## 18. Safety And Isolation

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

Linux isolation primitives such as cgroups and seccomp are not a complete
product strategy. Windows GPU developers need a Windows-specific isolation
plan.

Platform requirements:

- Linux: process groups, cgroups, seccomp/AppArmor where available, filesystem
  and network policy
- Windows: Job Objects for process and memory limits, process tree cleanup,
  restricted tokens or AppContainer-style isolation where feasible, filesystem
  and network policy
- WSL/containers: clearly report which host isolation boundary is actually in
  effect

### Runtime Memory And VRAM Reload Tiers

If the runtime intercepts `cudaMalloc`, `hipMalloc`, or equivalent allocator
calls for reload safety, the memory manager is part of the HMR contract.

Tier-B shadow arena behavior must track:

- total reserved bytes
- live allocation map
- free spans
- fragmentation ratio
- allocation owner and generation
- whether pointers may still be visible to host or device code

If a shadow arena allocation fails despite enough total free bytes, try a
bounded defragmentation or compaction pass only when live pointer safety is
provable. Otherwise reject the reload and choose a safe fallback such as warm
restart or cold runner restart. Do not promise arbitrary VRAM defragmentation
across vendor drivers.

Long tuning sessions need planned memory maintenance. Track reload generation
count, fragmentation ratio, largest free block, and recent allocation failure
reasons. By default:

- warn when reload generation exceeds 50 or fragmentation ratio exceeds 0.35
- recommend planned session refresh when generation exceeds 100 or
  fragmentation ratio exceeds 0.50
- force safe fallback before a known-large allocation would fail
- distinguish true memory pressure from fragmentation
- record whether refresh was planned, user-triggered, or forced by OOM risk

The product should prefer a predictable planned refresh over surprising
`CUDA_ERROR_OUT_OF_MEMORY`, HIP out-of-memory, or black-screen failure in the
middle of a tuning loop.

### GPU Driver Fault Domain And TDR Reality

Process isolation cannot fully sandbox a bad GPU instruction or runaway kernel.
On Windows, Timeout Detection and Recovery can reset the display driver. On
Linux, a bad kernel can hang a GPU queue or driver ring. In either case, the
supervisor may survive while the GPU device or preview session is no longer
trustworthy.

Product behavior should be:

- detect vendor timeout, reset, and device-lost errors where possible
- mark the runner/session/device as tainted after a suspected driver fault
- stop accepting screenshots as validation proof after a taint marker
- require cold runner restart or session/device reset before continuing
- surface the fault as a GPU driver/device event, not a normal compile error
- avoid claiming guaranteed sandboxing of arbitrary GPU kernels

GPU runaway handling is harder than CPU process killing. Product behavior
should be conservative:

- timeout kernel execution where API allows
- kill runner process on suspected runaway
- reset session state after GPU fault
- surface driver/device fault clearly
- avoid claiming guaranteed per-kernel kill across vendors

## 19. Observability

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
- toolchainCapabilityProfileHash
- toolchainCapabilityProfile
- splitCacheKey
- splitCacheHit
- patchTier
- reloadPlan
- arbiterDecision
- rankedReloadOptions
- consentRequired
- consentReason
- generatedRoles
- compileCommands
- deviceLinkCommands
- deviceSymbolTableHash
- affectedHeaderGraph
- affectedTemplateInstantiations
- templateEvidenceHash
- templateEvidenceStatus
- templateEvidenceInvalidationReasons
- templateArtifactFingerprintChanges
- templateTriageAgentDecision
- warmPathEstimateMs
- warmPathActualMs
- warmPathBudgetResult
- deviceLinkRequired
- deviceLinkEstimateMs
- deviceLinkActualMs
- deviceLinkBudgetResult
- deviceLinkerBound
- launchIndirectionTableVersion
- staleLaunchPointerChecks
- verifierRules
- reloadTimings
- screenshotTimings
- memoryArenaStats
- reloadGeneration
- vramFragmentationRatio
- largestFreeBlockBytes
- plannedMemoryRefresh
- gpuDriverFaultMarkers
- isolationBackend
- runnerPid
- runnerExitStatus
- crashMarkers
- artifactPaths
- agenticMode
- agenticAttemptCount
- agenticAcceptedAttempt
- agenticVerifierFailures

### Agentic Loop Trace Fields

Every agentic loop should log:

- `agenticMode`: `full_split` / `ai_delta` / `repair`
- attemptNumber
- input source context hash
- model
- prompt schema version
- output artifact hash
- verifier failures
- repair diff summary
- compile result
- runtime result
- accepted/rejected
- fallback chosen

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

## 20. Validation Matrix

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

### Failure-Mode Assertions

- stale launch pointer is rejected before reload
- warm path budget exceeded produces Arbiter fallback or consent request
- RDC project reports device-link required and linker-bound when over budget
- AI delta output can be rejected by deterministic verifier
- multi-role AI delta requires developer consent
- cold restart or state-loss fallback requires developer consent
- missing/stale toolchain capability profile blocks unsafe fast paths
- missing/stale template evidence blocks template warm rebuild
- project-local template constexpr arithmetic edit can use bounded warm rebuild
- layout-affecting constexpr edit is rejected with `constexpr_affects_layout`
- vendor template header edit is rejected with vendor boundary reason code
- Template Triage Agent proposal cannot bypass verifier rejection
- GPU driver TDR/device-taint prevents screenshot from being accepted as proof
- planned VRAM refresh is reported before predictable hard OOM
- unsupported incremental device-link reports vendor/toolchain reason

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

## 21. Backward Compatibility

Backward compatibility is required.

Implementation rules:

- read old sidecar shape
- write new sidecar shape
- migrate known fields opportunistically
- if required new fields are missing, do not fail existing run
- if required new fields are missing, disable unsafe fast path
- fall back to AI delta or full re-split

This avoids breaking current ROCm/GLFW validation and existing cached splits.

## 22. Revised Roadmap

### Milestone 0: Contracts And Instrumentation

Do this before more feature work.

Tasks:

- formalize `.synthi_split_meta.json`
- formalize reload plan schema
- formalize toolchain capability profile schema
- formalize Arbiter decision schema
- add reason-coded verifier output
- add run report
- show reload plan in UI/logs
- show fast path used
- show cache hit/miss reason
- preserve old sidecar compatibility

Done when:

- an engineer can explain every run without reading raw container logs

### Milestone 0.25: Arbiter And Capability Profile

Tasks:

- resolve selected compile command and effective flags for the target
- derive minimal toolchain capability profile before reload planning
- rank reload options by safety, latency, state loss, and capability support
- auto-run only safe, bounded, non-state-losing paths
- ask developer for cold restart, full re-split, multi-role AI delta,
  over-budget linker path, state loss, or unsafe/debug mode
- record Arbiter decision, ranked options, consent reason, and selected path in
  the run report

Done when:

- verifiers decide safety, Arbiter decides whether the safe path is worth
  running, and developer consent is requested only for costly or disruptive
  paths

### Milestone 0.5: Agentic Split/Verify Loop

Tasks:

- wrap full split in a bounded agentic loop
- add generated-role schema verifier
- add compile verifier
- add mapping verifier
- add no-user-tree-pollution verifier
- add runtime/screenshot verifier
- add repair loop for generated files only
- record every attempt in the run report

Done when:

- first split is not a single AI response
- first split is propose -> verify -> repair -> verify
- failed verification produces reason codes
- generated roles are persisted only after passing verification

Important distinction:

- Milestone 0.5: agentic full split and generated-artifact repair
- Milestone 1: deterministic direct device-only patch with no AI on
  successful body-only kernel edits
- Milestone 1 fallback: AI delta/verify loop

### Milestone 1: Direct User Device-Body Edit Path

Tasks:

- persist kernel/helper source mappings
- classify body-only edits
- patch generated device role locally
- verify kernel signatures
- verify constants/device globals
- require launch indirection for reloadable kernel entrypoints
- reject stale direct launch-wrapper pointers
- reject unbounded header/template dependency edits from the direct fast path
- confirm ABI/layout with selected vendor compiler artifacts where possible
- compile device sidecar only
- reload sidecar
- capture screenshot
- emit verifier artifacts and reload report

Initial scope:

- single device TU
- single generated device role
- selected compile command and effective flags available
- minimal toolchain capability profile available
- no macro-generated kernels
- no signature/layout edits
- no host launch edits
- no RDC/device-link changes
- one vendor path first

Done when:

- editing a mapped kernel arithmetic expression in user `.cu` / `.hip` avoids
  AI split, avoids AI delta, avoids host rebuild, and produces a visible
  post-HMR frame
- header/template edits without bounded dependency proof are rejected from
  direct `device_only` with reason codes
- `device_only` is never accepted without selected-target flags and toolchain
  capability profile

### Milestone 1.25: Runtime Reload ABI

Tasks:

- add Global Launch Indirection Table for generated kernel launch wrappers
- route every generated launch site through stable symbol-id table entries
- restrict direct `dlsym` / `GetProcAddress` usage to the loader
- atomically swap table targets only after verifier gates pass
- keep old sidecar artifacts alive until no in-flight launch can reference them
- add stale launch-pointer verifier and reload report fields

Done when:

- sidecar reload cannot leave the host runner calling a stale launch wrapper
- generated roles that bypass the indirection table are rejected before reload

### Milestone 1.5: Warm Deterministic Rebuild/Relink Path

Tasks:

- add affected header/device dependency report
- add Template Evidence Collector
- collect template instantiations reachable from mapped kernels
- distinguish project-local templates from vendor templates
- record constexpr/template parameters that influence layout, launch ABI,
  shared memory, constant memory, and generated code shape
- map each instantiation to owning TU, source headers, generated role, and
  kernel consumers
- persist source-level, ABI/layout, and artifact fingerprints in the sidecar
- invalidate fingerprints on compile flag, GPU arch, include graph, or source
  hash changes
- add Template Triage Agent for routing and explanation only
- add global device symbol table for generated device roles
- add warm path performance budget and timeout reporting
- rebuild affected generated roles without AI when impact is bounded
- relink affected sidecars or host/device bundles without full re-split
- reject direct `device_only` when template evidence is missing or stale
- allow `warm_rebuild` only when affected instantiations and roles are bounded
- reject unbounded dependency ripples with actionable reason codes

Done when:

- safe header/helper edits can use a deterministic warm path instead of full AI
  re-split
- bounded project-local template edits can use warm rebuild only with fresh
  compiler-derived evidence
- warm impact analysis uses cached metadata and stays within budget
- unsafe or unbounded header/template edits are rejected predictably
  without pretending to be instant HMR

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
- add global device symbol table across device TUs
- support CUDA device-link where required
- support HIP `-fgpu-rdc` where required
- map kernels to TUs
- reload affected sidecars or linked bundles

Done when:

- projects with multiple `.cu` / `.hip` files use HMR without forced
  flattening

### Milestone 4.5: Incremental Device Linking And RDC Cost Control

Tasks:

- capability-probe vendor incremental device-link behavior
- record device-link average and p95 latency per target/toolchain
- reuse cached objects where vendor tooling allows
- detect linker-bound warm paths before execution
- add AI-assisted diagnosis for device-link failures using symbol table,
  source mappings, generated role manifest, and linker output
- require Arbiter consent for over-budget RDC link paths
- surface project suggestions for isolating hot kernels when RDC blocks HMR

Done when:

- RDC correctness is supported separately from RDC performance claims
- linker-bound paths are reported as cost-bound fallbacks, not hot HMR

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
- add Windows Job Object / restricted-process isolation plan
- add runtime allocator/shadow-arena reporting
- add bounded VRAM defragmentation or safe fallback behavior
- add long-session VRAM refresh policy
- add GPU driver TDR/device-taint detection and recovery UX
- add crash cleanup
- separate unsafe debug mode

Done when:

- a crashing or hostile runner cannot corrupt the supervisor on supported
  platforms
- GPU driver/device faults are surfaced as tainted-session recovery, not
  ordinary HMR failures

## 23. Updated Definition Of Production Ready

GPU HMR is production-grade only when all are true:

1. Runs start from real build targets, not guessed files.
2. Target compile flags and link flags are preserved.
3. Toolchain capability profile exists before reload planning.
4. Arbiter ranks safe options and applies consent policy.
5. Large repos use deterministic source graph selection.
6. AI split, AI delta, and AI repair paths are verifier-gated.
7. User `.cu` / `.hip` body edits use direct device-only HMR.
8. Header/template edits use warm deterministic rebuild or explicit fallback.
9. Template impact is bounded by compiler-derived evidence, not RAG or LLM
   judgment.
10. ABI-breaking edits are blocked before unsafe reload.
11. Vendor compiler artifacts confirm ABI/layout safety where required.
12. Runtime reload uses a verified launch indirection table.
13. Warm rebuild has measured budget limits and clear fallback.
14. RDC/device-link cost is measured and reported separately from safety.
15. Multi-device-TU projects are supported or clearly rejected.
16. Generated roles remain internal and inspectable.
17. Every run shows which fast path was used.
18. CUDA and ROCm pass the supported framework matrix.
19. Failures are categorized and actionable.
20. Native runner crashes are isolated on supported platforms.
21. GPU driver faults are treated as tainted-session recovery events.
22. Validation reports are reproducible and current.

## 24. Recommended Immediate Task

Implement the next work in five steps.

Step 0: add the Arbiter and toolchain capability contract:

```text
selected target
  -> resolve compile command and effective flags
  -> derive toolchain capability profile
  -> rank candidate reload options
  -> auto-run safe, bounded, non-state-losing paths
  -> ask developer for costly, state-losing, or experimental paths
```

Step 1: add the Milestone 0.5 shell around the existing full split path:

```text
full split request
  -> agent proposes generated roles and mappings
  -> deterministic schema/mapping/compile/runtime verifiers run
  -> repair generated roles if a verifier fails
  -> bounded retry
  -> persist sidecar only after verification passes
```

Step 2: implement the Milestone 1 direct device edit vertical slice:

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

Step 3: add the runtime reload ABI:

```text
generated launch site
  -> call stable launch indirection table entry
  -> compile/reload produces new sidecar artifact
  -> verifier confirms all launch sites use indirection
  -> loader atomically swaps table targets
  -> old artifact remains alive until in-flight launches complete
```

Step 4: add the warm deterministic rebuild/relink path for bounded
header/template dependency edits:

```text
user edits device-reachable .cuh/.hpp helper
  -> compute affected header/device dependency graph
  -> consult Template Evidence Collector for template impact
  -> enumerate affected mappings and template instantiations where possible
  -> rebuild/relink affected generated roles without AI
  -> verify vendor compiler artifacts
  -> reload or choose explicit fallback
```

Do not start with multi-TU or full CMake generality. Start with one target and
one device TU, but build the metadata and verifier as if multi-TU will arrive
next. Direct body-only edits should stay non-agentic when local proof succeeds.
Header/template edits should not be sold as instant HMR unless their dependency
ripple is bounded and verified.

Runtime reload should not be considered safe until launch indirection is in
place. Long tuning sessions should report VRAM fragmentation and planned refresh
state before users hit a surprise driver or allocation failure.

RDC/device-link performance should not be implied by correctness. If vendor
linking is required and over budget, report it as linker-bound and let the
Arbiter request consent or choose a clearer fallback.
