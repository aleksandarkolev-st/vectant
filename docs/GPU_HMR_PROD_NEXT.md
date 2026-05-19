# GPU HMR Production Next Plan

Date: 2026-05-20

This document combines the current GPU HMR validation status with the next
engineering work required to make the pipeline production-grade for engineers
working on large native GPU projects with hundreds or thousands of files.

## Executive Summary

The GPU HMR mechanism is real and already useful:

- first run can AI-split an ordinary user project into internal Synthi HMR roles,
- generated role files stay internal and do not pollute the user workspace,
- CUDA is reported working,
- ROCm/GLFW was validated end-to-end on `gfx1201`,
- device-only sidecar reload works without full app restart,
- screenshots prove visible output before and after HMR.

The remaining production work is mostly about scale, determinism, and breadth:

- build-system integration for real CMake/compile database projects,
- source graph selection for thousands of files,
- direct user `.cu` / `.hip` edit mapping into the generated device role,
- multi device translation unit support,
- stronger failure UX, observability, and artifact inspection,
- a real vendor/framework validation matrix.

The intended production model is:

1. Full AI split once per project/target/version.
2. Persist an internal sidecar with the generated roles, architecture cache,
   manifest, and source baseline.
3. For edits, avoid full AI split whenever possible.
4. Prefer local deterministic patching, then AI delta/diff patch, then full
   re-split only as a last resort.
5. For device-only kernel body edits, compile and reload only the device
   sidecar.

## Current Working Baseline

### Validated Behavior

The latest dense validation proved the following for the ROCm/GLFW path:

- Run file: `src/app/main.cpp`
- Workspace: `293` user files
- Relevant source mix: `51` `.cpp` / `.hpp` / `.h` / `.hip` files
- GPU target: ROCm `gfx1201`
- Render backend: GLFW/OpenGL
- First compile: full AI GPU split
- Device HMR: device-only sidecar compile and reload
- Generated roles: `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`,
  `device.hip`
- Generated roles are internal only and are not written to the visible user
  workspace
- Device reload succeeded with preserved runner state
- First and post-HMR screenshots were visibly non-black and materially different

Representative validation workspace:

```text
http://localhost:3000/workspace/gpu-scale-validation-glfw-userfiles-20260519233656
```

Representative validation report:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/scale-validation-glfw-results.txt
```

### Current Fast Paths

The current speed comes from multiple layers. These should be preserved and
made more deterministic.

#### 1. First Run: Full AI Split

The first run from the user entry file does the expensive work:

```text
ordinary user project
  -> full GPU AI split
  -> internal shared/core/gui/host_runner/device roles
  -> compile
  -> runner launch
```

This is expected to be seconds-level latency. In the latest ROCm/GLFW
validation, the first full split and compile took about 14 seconds.

#### 2. Repeat Run: Split Cache

The worker caches AI split output by a key that includes:

- primary source,
- file context,
- GPU vendor and arch,
- model,
- split schema version,
- GPU mode flags.

Repeat runs of the same project can skip the full AI split.

#### 3. Post-Split User Edits: Adapted Project Path

After first split, the worker has an internal sidecar:

```text
.synthi_split_meta.json
```

The sidecar tracks:

- original user source baseline,
- architecture cache,
- compile manifest,
- generated role paths.

When the user edits the original source and runs again, the worker compares old
user source to new user source and tries:

1. Tier 0 / Tier 1 local value patching, no AI.
2. Tier 2 AI diff/delta patch, tiny edit list, no full split.
3. Tier 3 full AI re-split only if the patch path fails.

#### 4. Device-Only Generated Role HMR

The validation harness proved the fastest current GPU path:

```text
edit generated device source internally
  -> compile device.cu/device.hip only
  -> reload sidecar
  -> no full split
  -> no AI delta
  -> no host module rebuild
```

In the validation report, the device-only HMR phase was about 1 second end to
end, and the actual device reload took only a few milliseconds.

## Best Production Fast Path

The production goal should be:

```text
first run:
  full AI split once

normal edits:
  local patch when deterministic
  otherwise AI diff/delta patch
  full AI re-split only on failure

device kernel body edits:
  classify as device-only
  update generated device role
  compile device sidecar only
  reload sidecar
```

The most important next optimization is:

```text
user .cu/.hip body edit
  -> map directly to generated device role
  -> verify kernel signatures and constant layout unchanged
  -> compile/reload device sidecar
  -> skip full AI split
  -> often skip AI delta
```

That would make the common GPU tuning loop nearly as fast as the internal
validation path.

## Production-Grade Requirements

### 1. Real Build-System Integration

Current state:

- The splitter infers a compile manifest from source and file context.
- This works for curated projects and some straightforward workspaces.
- It is not enough for large engineer-owned repositories.

Production requirement:

- ingest `compile_commands.json`,
- understand CMake targets,
- preserve include directories,
- preserve preprocessor defines,
- preserve target-specific link flags,
- preserve framework/library flags,
- map the clicked Run file to the actual build target,
- surface target ambiguity instead of guessing.

Without this, large projects will fail on missing macros, generated headers,
private include roots, platform defines, or target-specific link options.

Acceptance criteria:

- A CMake project with multiple targets can select the correct app target.
- Split manifest includes the same effective include dirs, defines, standard,
  and link flags as the source target.
- Missing or ambiguous target selection returns an actionable error card.

### 2. Scalable Source Graph Selection

Current state:

- The worker can pass a large file set.
- The GPU splitter now receives multi-file context.
- Prompt budget still requires truncation and prioritization.

Production requirement:

- build a dependency graph from the entry target,
- include transitive headers,
- include device translation units,
- include relevant render/backend files,
- include build config and target metadata,
- exclude docs, vendor blobs, generated outputs, and unrelated modules,
- record exactly which files were included and why.

The AI should not see "a lot of files"; it should see the right files.

Acceptance criteria:

- A 5,000-file repo can produce a bounded source context.
- Context selection is deterministic and logged.
- Dropped files are explainable by rule, not silent prompt-budget loss.

### 3. Direct User Device Edit Mapping

Current state:

- Internal generated device-only edits are fast.
- User `.cu` / `.hip` edits still need stronger mapping into the generated
  device role.

Production requirement:

- maintain source-to-generated mapping for kernels, constants, helpers, and
  launch sites,
- classify user device edits as body-only, signature-changing, constant-layout
  changing, or mixed host/device,
- apply safe body-only edits directly to the generated device role,
- run signature and constant layout verification,
- compile only the device sidecar when ABI is unchanged.

Acceptance criteria:

- Editing a kernel arithmetic expression in user `.cu` / `.hip` triggers
  `device_only` without AI re-split.
- Editing a kernel signature triggers `abi_breaking`.
- Editing host launch arguments triggers `mixed` or `abi_breaking` as needed.
- The UI explains the chosen reload plan.

### 4. Multi Device Translation Unit Support

Current state:

- The current GPU HMR contract supports one generated device role:
  `device.cu` or `device.hip`.

Production requirement:

- support multiple source `.cu` / `.hip` files,
- support device headers,
- support separate compilation where possible,
- support device linking where required,
- map kernels to device translation units,
- reload only the affected sidecar or linked bundle when safe.

Acceptance criteria:

- Multiple user device files can be split without flattening everything into
  one brittle generated file.
- Device-only edits in one translation unit do not force unrelated device
  recompiles when the ABI allows it.
- Unsupported RDC/device-link cases produce clear fallback behavior.

### 5. ABI, State, And Reload Plan Hardening

Current state:

- Kernel signature hashes and constant layout checks exist.
- Device-only HMR works for unchanged signatures/layout.

Production requirement:

- tighten reload plan classification,
- record kernel ABI before and after every edit,
- detect constant-memory layout changes,
- detect state layout changes,
- decide between `device_only`, `host_only`, `mixed`, and `abi_breaking`
  deterministically,
- preserve state where possible and explain when cold reload is required.

Acceptance criteria:

- Every reload decision has a machine-readable reason.
- ABI-breaking changes cannot accidentally use `device_only`.
- Device-only edits preserve runner process and host module state.

### 6. Framework And Vendor Matrix

Current state:

- CUDA is reported working.
- ROCm/GLFW is end-to-end validated.
- SDL2 and GLFW are the most mature paths.
- Other libraries are prompt-supported but not fully matrix-proven.

Production requirement:

Run end-to-end validation across:

- CUDA + SDL2,
- CUDA + GLFW/OpenGL,
- ROCm + SDL2,
- ROCm + GLFW/OpenGL,
- raylib,
- SFML,
- ImGui on SDL/GLFW,
- OpenGL context edge cases,
- Vulkan or explicit unsupported/fallback handling.

Acceptance criteria:

- Each matrix case has:
  - first compile,
  - visible screenshot,
  - device-only edit,
  - post-HMR screenshot,
  - no generated role files in the user workspace,
  - logged reload plan,
  - runner survival check.

### 7. Failure UX For Engineers

Current state:

- Failures are mostly visible in logs and validation reports.
- Engineers need better immediate feedback.

Production requirement:

- show exact missing include/library/target reason,
- show verifier rejection reason,
- show whether the system used full split, delta patch, or device-only path,
- offer concrete next actions,
- never silently produce a wrong or black app.

Acceptance criteria:

- Compile failures are categorized.
- AI split verifier failures are shown with stable rule names.
- Unsupported project structures return "not supported yet" with a reason,
  not a vague compile error.

### 8. Generated Artifact Lifecycle And Inspection

Current state:

- Generated role files are internal and no longer pollute the visible user
  workspace.

Production requirement:

- keep generated roles internal by default,
- provide an internal generated split viewer for debugging,
- show user source to generated role mapping,
- show generated manifest and compile commands,
- clean up old temp builds,
- prevent stale generated artifacts from being confused with user files.

Acceptance criteria:

- User file tree remains user-authored.
- Engineers can inspect generated roles through an explicit debug panel.
- Every generated artifact has provenance: source hash, target, model,
  manifest, and timestamp.

### 9. Performance And Caching

Current state:

- AI split cache exists.
- Incremental compile cache exists.
- Speculative diff patching exists for some edit flows.

Production requirement:

- stronger cache keys based on build target and compile flags,
- file-level hashing for thousands of files,
- send changed files only after first split where safe,
- speculative diff patch when user pauses,
- avoid duplicate AI calls between save and compile,
- make device-only edits avoid host rebuilds consistently.

Acceptance criteria:

- No repeated full AI split for unchanged project state.
- Common kernel body edit reaches visible post-HMR frame in low single-digit
  seconds.
- Cache hit/miss reasons are logged.

### 10. Safety And Isolation

Current state:

- The current dev pipeline can run arbitrary native code.
- Some validation paths use unsafe/in-process runner mode.

Production requirement:

- isolate user native processes,
- enforce CPU/GPU/memory/time limits,
- contain runner crashes,
- kill runaway kernels where possible,
- separate debug unsafe mode from normal product mode,
- clean temporary workspaces and GPU artifacts.

Acceptance criteria:

- A crashing runner does not corrupt the supervisor.
- Resource limits are enforced per session.
- Unsafe mode is opt-in and visible.

### 11. Observability

Production debugging requires structured traces for:

- selected entry file,
- selected build target,
- selected source context files,
- AI split cache key and hit/miss,
- AI model and prompt schema version,
- generated manifest,
- generated role paths,
- compile command for each module,
- reload plan,
- HMR timing,
- screenshot readiness timing,
- verifier rejection rules,
- crash markers.

Acceptance criteria:

- One run report can explain why a compile was slow or why it rebuilt.
- Engineers can distinguish "AI split", "AI delta", "local patch",
  "device-only compile", and "cold reload" from UI/logs.

## Implementation Roadmap

### Milestone 1: Make Current Fast Path Explicit

Tasks:

- expose reload plan in UI/logs,
- expose whether run used full split, cache, local patch, AI delta, or
  device-only compile,
- add direct report links from workspace,
- document the Run file and expected edit files.

Done when:

- an engineer can tell why a run was fast or slow without reading container
  logs.

### Milestone 2: Direct User Device Edit To Device-Only HMR

Tasks:

- persist kernel source mapping from user `.cu` / `.hip` to generated device
  role,
- classify device body edits,
- apply safe body edits to generated device role,
- verify unchanged signature and constant layout,
- compile/reload device sidecar only.

Done when:

- editing a kernel arithmetic expression in the user device file avoids full
  split and avoids host rebuild.

### Milestone 3: Build Graph Ingestion

Tasks:

- parse `compile_commands.json`,
- infer CMake targets,
- map Run file to target,
- preserve include dirs, defines, standards, and link flags,
- update compile manifest generation to use target data.

Done when:

- a nontrivial CMake GPU app builds through Synthi without manual flag
  guessing.

### Milestone 4: Large Repo Context Engine

Tasks:

- build source graph selection,
- rank and cap files deterministically,
- include transitive headers/device/render/build config,
- log included and omitted files.

Done when:

- a thousands-file repo can be split with a bounded, explainable context.

### Milestone 5: Multi Device TU

Tasks:

- extend manifest for multiple device roles,
- support per-TU compile,
- support device link where required,
- map kernels to TUs,
- reload affected sidecars.

Done when:

- projects with multiple `.cu` / `.hip` files can use GPU HMR without forced
  flattening into one file.

### Milestone 6: Production Matrix

Tasks:

- add validation fixtures for CUDA/ROCm and SDL2/GLFW/raylib/SFML/ImGui,
- run first compile and device-only HMR for each,
- assert no generated files in user tree,
- record artifacts.

Done when:

- every supported backend has a current passing report.

## Non-Goals For The Next Phase

These are important, but should not block the next production hardening pass:

- arbitrary proprietary engine integration without build metadata,
- full Vulkan HMR if context/swapchain ownership is not modeled,
- automatic support for every CUDA RDC/device-link layout,
- zero-latency first compile,
- exposing generated role files as normal user workspace files.

Generated role files should remain internal. Inspection should happen through a
debug viewer, not by writing `core.cpp`, `gui.cpp`, `host_runner.cpp`,
`shared.h`, or `device.cu/.hip` into the user tree.

## Definition Of Production Ready

GPU HMR can be called production-grade for engineers when:

1. First run works from a real build target, not a guessed file.
2. Thousands-file repos use deterministic source graph selection.
3. Common `.cu` / `.hip` body edits use direct device-only HMR.
4. ABI-breaking edits are detected before unsafe reload.
5. Generated files remain internal and inspectable.
6. Every run shows which fast path was used.
7. CUDA and ROCm pass the supported framework matrix.
8. Failures are actionable without reading raw container logs.
9. Crashes and runaway native code are isolated.
10. Validation reports are current, reproducible, and checked into the repo.

## Recommended Next Task

Implement the direct user device edit path:

```text
user edits src/gpu/*.cu or src/gpu/*.hip
  -> classify body-only vs ABI-changing
  -> map edit into generated device role
  -> verify signatures/constants unchanged
  -> compile device sidecar only
  -> reload sidecar
  -> capture screenshot
```

This gives the largest practical win because kernel tuning is the highest
frequency GPU workflow, and it should not require full AI split or host module
rebuilds.
