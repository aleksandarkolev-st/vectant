# GPU HMR Prod Next - Next Session Handoff

Date: 2026-05-20

## Branch Recommendation

Yes: if the current GPU HMR validation work is pushed and the branch is clean,
merge it, then start a new branch for production hardening.

Recommended shape:

```text
merge current validation branch
  -> update local dev/main
  -> create feature/gpu-hmr-prod-orchestrator
  -> implement Milestone 0.25 arbiter/capability profile first
  -> implement Milestone 0.5 split/verify shell next
  -> implement Milestone 1 direct device-body path next
  -> add runtime reload ABI before trusting sidecar swaps
  -> add warm path and RDC cost controls after the direct slice
```

Reason: the validation branch proved an important end-to-end path. The next
work is architectural production hardening, not more proof-of-concept cleanup.
Keeping it on a fresh branch makes review easier and keeps validation evidence
separate from product architecture changes.

Do not merge if the branch has uncommitted work, failing validation that used
to pass, or missing proof artifacts for the claimed backend. If merge happens
through GitHub, open a PR and keep the language conservative: "ROCm/GLFW path
validated" rather than "GPU HMR production-ready."

## Canonical Documents

Use this file as the immediate handoff, but treat these as source-of-truth:

```text
docs/GPU_HMR_PROD_NEXT.md
tmp/codex-next-gpu-hmr-scale-validation.md
```

`docs/GPU_HMR_PROD_NEXT.md` is the production roadmap. Follow it first.

`tmp/codex-next-gpu-hmr-scale-validation.md` is the historical validation
handoff. Use it for stack commands, MCP harness patterns, screenshot evidence,
worker/ai-engine log markers, and the difference between pre-split validation
and user-facing seed-only validation. Do not let it override the production
roadmap.

## Current Truth

Proven so far:

- ROCm/GLFW validation is a real milestone.
- A large user-style workspace was validated with roughly 293 user files.
- Relevant GPU source context included `.cpp`, `.hpp`, `.h`, and `.hip`.
- Generated Synthi roles are now supposed to remain internal, not appear as
  ordinary user files.
- Device-side reload succeeded in the proven path.
- Runner state was preserved in the proven path.
- Screenshots were visible before and after HMR.

Not production-proven yet:

- CUDA production readiness.
- Multi-target CMake resolution.
- Full build metadata preservation from real targets.
- Multi-device-TU projects.
- RDC/device-link reload topology.
- Vulkan HMR.
- Safe reload under ABI-changing edits.
- Native runner isolation hardening.
- Large real-project source graph selection beyond validation fixtures.
- Arbiter/capability-profile policy decisions.
- RDC/device-link cost control separate from correctness.

Use careful wording:

```text
Good: ROCm/GLFW path validated.
Good: CUDA path exists but requires matrix validation.
Bad: GPU HMR is production-ready.
Bad: CUDA works in production.
```

## New Architecture To Implement

The next branch should start with a small deterministic policy shell before
the Agentic Split/Verify Orchestrator.

Core decision split:

```text
Verifiers decide: is this option safe and valid?
Arbiter decides: is this safe option worth running now?
```

The Arbiter is not an LLM authority. It is a deterministic policy engine that
uses verifier results, target/toolchain capabilities, expected latency,
state-loss risk, stale-pointer checks, VRAM state, and prior run history to
choose `auto_run`, `ask_developer`, `skip`, `fallback`, or `unsupported`.

Developer consent is required for cold restart, full AI re-split, multi-role
AI delta, linker-bound or over-budget warm paths, state migration/loss,
unsafe/debug mode, experimental toolchain capability, or GPU/device taint.

Template-heavy edits need a separate hard subsystem:

```text
compiler-derived template evidence first
AI-assisted routing/repair second
verifier decides
Arbiter controls cost
```

Do not let AI or RAG certify Thrust, CUTLASS, or project-local template impact.

Core rule:

```text
AI output is never trusted directly.
```

Every AI split, AI delta, or AI repair must pass deterministic verification
before:

- writing sidecar state
- enabling `device_only`
- reloading the runner
- marking validation as passed

The agent may propose generated roles, mappings, repair patches, and AI delta
patches. It may not certify ABI safety, bypass parser failures, bypass compile
failures, write generated roles into the user workspace, silently fall back to
full re-split, or mutate user source.

## Immediate Roadmap

### Step 0: Milestone 0.25 - Arbiter And Capability Profile

Goal:

```text
selected target
  -> resolve selected compile command and effective flags
  -> derive minimal toolchain capability profile
  -> rank candidate reload options
  -> auto-run safe, bounded, non-state-losing paths
  -> ask developer for costly, state-losing, or experimental paths
```

Tasks:

- Resolve selected compile command identity and effective flags hash.
- Derive `toolchainCapabilities` before reload planning.
- Rank candidate reload options by safety, latency, state loss, and capability
  support.
- Auto-run only when deterministic verifiers pass, latency is within tier
  budget, no state is lost, no stale pointer risk exists, and no consent rule
  is triggered.
- Ask for cold restart, full re-split, multi-role AI delta, over-budget linker
  path, state loss, unsafe/debug mode, or tainted GPU/device state.
- Record Arbiter decision, ranked options, consent reason, and selected path in
  the run report.

Done when:

- Verifiers decide safety.
- Arbiter decides whether the safe path is worth running.
- Developer consent is requested only for costly or disruptive paths.
- Missing or stale capability profile blocks `device_only` and `warm_rebuild`.

### Step 1: Milestone 0.5 - Agentic Split/Verify Loop

Goal:

```text
full split request
  -> agent proposes generated roles and mappings
  -> deterministic schema/mapping/compile/runtime verifiers run
  -> repair generated roles if a verifier fails
  -> bounded retry
  -> persist sidecar only after verification passes
```

Tasks:

- Wrap the current full GPU split path in a bounded attempt loop.
- Add generated-role schema verifier.
- Add mapping verifier.
- Add compile verifier.
- Add no-user-tree-pollution verifier.
- Add runtime/screenshot verifier.
- Allow repair only for internal generated files.
- Record every attempt in the run report.
- Store prompt hashes/model/schema/source file list/verifier results, not raw
  prompts by default.

Done when:

- First split is not a single AI response.
- First split is propose -> verify -> repair -> verify.
- Failed verification produces reason codes.
- Generated roles are persisted only after passing verification.
- A failed verifier cannot be waved through by the LLM.

Hard limits:

- Max full split attempts: 2 or 3.
- Max repair attempts per failure class: 1 or 2.
- No infinite repair loops.
- No repair of user source without explicit user action.
- No generated artifact accepted after failed verifier.

### Step 2: Milestone 1 - Direct User Device-Body Edit Path

Goal:

```text
user edits src/gpu/*.hip or src/gpu/*.cu
  -> detect changed mapped kernel body
  -> classify body-only
  -> patch generated device role locally
  -> verify signature and constant/global layout
  -> compile device sidecar only
  -> reload sidecar
  -> capture screenshot
  -> emit reload report
```

This fast path must be non-agentic when local proof succeeds.

Acceptance:

- Arithmetic body edit: `device_only`, no AI call, no host rebuild, no full
  re-split, runner survives, screenshot captured.
- Signature edit: `abi_breaking`, `device_only` rejected, reason code shown.
- Constant/global edit: `abi_breaking`, `device_only` rejected, reason code
  shown.
- Parse failure: `device_only` rejected, fallback chosen, reason code shown.
- Old sidecar: existing flow still works, unsafe fast path disabled unless
  required fields exist.
- `device_only` is never accepted without selected-target flags and a current
  toolchain capability profile.

### Step 3: Milestone 1.25 - Runtime Reload ABI

Goal:

```text
generated launch site
  -> call stable launch indirection table entry
  -> compile/reload produces new sidecar artifact
  -> verifier confirms all launch sites use indirection
  -> loader atomically swaps table targets
  -> old artifact remains alive until in-flight launches complete
```

Done when:

- Sidecar reload cannot leave the host runner calling a stale launch wrapper.
- Generated roles that bypass the indirection table are rejected before reload.
- `reload_failed.stale_launch_pointer` is a first-class failure reason.

### Step 4: Milestone 1.5 - Warm Path, Then RDC Cost Control

Goal:

```text
bounded header/helper edit
  -> compute affected dependency graph from cached metadata
  -> consult Template Evidence Collector for template impact
  -> rebuild or relink affected roles without AI
  -> verify vendor compiler artifacts
  -> Arbiter auto-runs only if within budget
```

Warm path budgets:

- impact analysis target: under 250 ms
- impact analysis hard cap: 1,000 ms
- single affected role rebuild/relink target: under 2 seconds
- warm path soft cap: 5 seconds

RDC/device-link rule:

```text
if device-link is required and expected linker time exceeds budget
  -> report device_linker_bound
  -> ask developer or choose clearer fallback
```

Do not market linker-bound RDC rebuilds as hot HMR.

Template policy:

```text
template touched
  -> reject device_only by default
  -> warm_rebuild only with fresh bounded evidence
  -> otherwise ai_delta/full_resplit/unsupported
```

## AI Split And Delta Implications

Yes, this changes AI split and AI delta behavior.

Before:

```text
AI generates split/delta
  -> pipeline tries to compile/use it
```

After:

```text
AI proposes split/delta/repair
  -> deterministic verifiers accept or reject
  -> accepted output persists/reloads
  -> rejected output triggers bounded repair or fallback
```

Direct `device_only` stays local and deterministic. AI only enters when local
proof fails or a full split/re-split is needed.

## Arbiter Contract And HMR Tiers

The Reload Planner may produce multiple safe candidate plans. The Arbiter must
rank them and apply policy before execution.

Minimum Arbiter output:

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

Allowed Arbiter decisions:

- `auto_run`
- `ask_developer`
- `skip`
- `fallback`
- `unsupported`

HMR tiers:

- Tier 0: `device_only`, no AI, no host rebuild, target under 1 second where
  the toolchain allows.
- Tier 1: `warm_rebuild`, no AI, cached dependency graph only, target 1-5
  seconds.
- Tier 2: `ai_delta`, architecture-aware generated-role patching, verifier
  gated, occasional fallback rather than normal edit loop.
- Tier 3: `full_resplit`, heavy fallback, not a hot path, requires Arbiter
  justification and developer consent unless explicitly configured otherwise.

Agentic HMR does not mean AI on every edit. AI is available for split, repair,
explanation, and hard deltas; the Arbiter keeps the hot path deterministic and
cheap.

## Template Evidence Collector And Triage Agent

This is a hard subsystem, not a warm-rebuild footnote.

Purpose:

```text
compiler-derived template impact evidence for device-reachable code
```

Runs:

- background
- first split
- warm cache refresh
- explicit rebuild
- not unbounded on edit hot path

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

- affected instantiations
- affected generated roles
- source-level fingerprints
- artifact-level fingerprints
- ABI/layout fingerprints
- invalidation reasons

Authority:

- may bound template impact
- may reject stale evidence
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

Template Triage Agent:

- reads template evidence, mappings, include graph, generated roles, compiler
  errors, prior verifier failures, and architecture summary
- proposes `warm_rebuild`, `ai_delta`, `full_resplit`, or `unsupported`
- cannot certify `device_only` safety, ABI safety, layout safety, or complete
  instantiation coverage

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

## CPU HMR Boundary

Updating GPU HMR does not require a full CPU HMR rewrite.

If CPU and GPU share split/delta infrastructure, update the shared contract so
CPU HMR also stops trusting one-shot AI output. CPU HMR does not need
GPU-specific gates such as:

- kernel signature verifier
- constant/global device symbol layout verifier
- GPU architecture verifier
- CUDA/HIP device-link verifier
- GPU screenshot/frame verifier

CPU HMR should still use the same general pattern:

```text
AI proposes generated artifacts or deltas
  -> deterministic CPU/build/runtime verifiers decide
  -> accepted output is persisted or reloaded
```

Do not block GPU production work on a CPU rewrite. Only touch CPU HMR if the
shared split/delta engine requires a contract change to avoid accepting raw AI
output.

## Minimal Sidecar Contract For Next Work

Required for Milestone 1:

- `schemaVersion`
- target identity
- selected compile command identity and effective flags hash
- toolchain capability profile
- template evidence store hash, when available
- source baseline hashes
- generated role paths
- user-to-generated device mappings
- kernel signature hashes
- constant/global layout hashes
- last reload plan report

Agentic summary fields:

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

Forward-compatible but not required for the first slice:

- host state layouts
- multi-TU device role list
- CMake codemodel hashes
- device-link graph
- launch indirection table version
- arbiter decision history
- template evidence invalidation history
- warm path budget history
- device-link budget history
- full source context report
- runner isolation metadata
- runtime memory arena statistics
- GPU driver fault markers

Backward compatibility rule:

```text
read old sidecar shape
  -> write new sidecar shape
  -> migrate known fields opportunistically
  -> if required fields are missing, keep existing flow working
  -> disable unsafe fast path
  -> fall back to AI delta or full re-split
```

## Toolchain Capability Profile

Every reload decision must be backed by a selected toolchain capability profile
derived from compile metadata, vendor/toolchain probes, and measured history
for the selected target/configuration.

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

If the profile is missing or stale:

```text
toolchain_capability_missing or toolchain_capability_stale
  -> Arbiter blocks device_only and warm_rebuild
  -> choose fallback or ask developer
```

## Build Metadata Rules

Build metadata is mandatory for production proof.

The splitter and parser must consume selected-target metadata before making
split or safety decisions. Do not infer flags from code.

Use:

- `compile_commands.json`
- CMake File API codemodel
- CMake cache/configuration
- selected target name
- source-to-target mapping
- compiler identity
- include directories
- defines/undefines
- GPU arch flags
- RDC/device-link flags
- link flags and framework/library flags

Important reason:

`compile_commands.json` can contain multiple command objects for the same file
under different configurations. The selected target/config must be explicit,
and the `arguments` form is safer than shell-parsed `command`.

If metadata is incomplete:

```text
no device_only proof
  -> fallback to AI delta or full re-split
  -> show missing metadata reason
```

Milestone 1 is allowed to use a minimal selected-target compile-command
resolver before full CMake target integration lands, but it must not pretend
that guessed flags are proof. The direct path needs selected-target effective
flags and a current capability profile.

## Device Compilation Rules

The verifier must know when generated device roles require device linking.

CUDA separate compilation/device linking is real compilation topology, not a
cosmetic flag. HIP has the same class of issue with RDC.

The splitter must emit:

- device role list
- per-role compiler command
- RDC/device-link requirement
- affected device-link bundle
- reload granularity

If this cannot be modeled:

```text
unsupported.device_link_topology_unmodeled
```

RDC correctness and RDC performance are separate claims. A global device symbol
table can explain dependencies and make repair possible, but it does not make
`nvlink` or HIP device-link fast.

Track for RDC/device-link cost control:

- whether RDC is required
- whether incremental device linking is supported
- affected bundle size
- cached object reuse rate
- device-link average and p95 latency
- last device-link elapsed time

If device-link is required and expected time exceeds budget:

```text
device_linker_bound
  -> Arbiter asks developer or chooses fallback
```

For the first production slice, keep scope narrow:

- one selected target
- one device translation unit
- one vendor path first
- existing generated device role
- mapped kernel/helper body-only edits
- no macro-generated kernels
- no signature/layout edits
- no host launch edits
- no RDC/device-link topology changes

## What To Prove Next

For Milestone 0.25:

- Selected compile command identity and effective flags hash are recorded.
- Toolchain capability profile is created before reload planning.
- Missing/stale capability profile blocks unsafe fast paths.
- Arbiter records ranked options, selected path, consent reason, and decision.
- Auto-run occurs only for safe, bounded, non-state-losing paths.
- Cold restart, full re-split, multi-role AI delta, state loss, unsafe/debug
  mode, and linker-bound warm paths require consent.

For Milestone 0.5:

- AI full split goes through propose -> verify -> repair -> verify.
- Generated role schema is checked.
- Mapping output is checked.
- Compile failures are repaired only in generated files.
- Generated files never appear as ordinary user files.
- Runtime/screenshot verifier blocks black-screen acceptance.
- Sidecar is persisted only after all required gates pass.
- Run report records attempt count, verifier results, and accepted attempt.

For Milestone 1:

- A mapped kernel arithmetic edit uses direct `device_only`.
- No AI call occurs on the successful direct body-edit path.
- Host does not rebuild.
- Runner survives.
- Post-HMR screenshot is visible and materially changed.
- Signature/constant/global/parse-failure cases are rejected with reason codes.
- Verifier artifacts save before/after evidence for every rejection.
- Direct `device_only` is blocked without selected-target flags and capability
  profile.

For Milestone 1.25:

- Every generated launch site routes through the Global Launch Indirection
  Table.
- Direct `dlsym` / `GetProcAddress` usage is restricted to the loader.
- Stale launch pointer detection rejects reload before execution.
- Old sidecar artifacts remain alive until no in-flight launch can reference
  them.

For Milestone 1.5 Template Evidence Collector:

- Project-local `.cuh` fixture records two explicit instantiations.
- Template evidence maps each instantiation to owning TU, source headers,
  generated role, and kernel consumers.
- Arithmetic-only constexpr can use bounded `warm_rebuild`.
- Layout-controlling constexpr is rejected as ABI/layout affecting.
- Stale template evidence blocks `warm_rebuild`.
- Vendor template header edits are rejected with vendor boundary reason codes.
- Template Triage Agent can propose a candidate path but cannot mark it safe.

For Milestone 4.5:

- RDC projects report device-link required.
- Device-link average and p95 latency are recorded.
- Cached object reuse is measured.
- Linker-bound warm paths are detected before execution.
- Unsupported incremental device-link reports vendor/toolchain reason.
- Over-budget RDC link paths require Arbiter consent.

Verifier rejection artifacts should include:

- before signature hash
- after signature hash
- before constant/global layout hash
- after constant/global layout hash
- changed user span
- mapped generated span
- parser status
- rejection rule
- chosen fallback

Failure-mode assertions to add to validation:

- stale launch pointer is rejected before reload
- warm path budget exceeded produces Arbiter fallback or consent request
- RDC project reports device-link required and linker-bound when over budget
- missing/stale template evidence blocks template warm rebuild
- project-local template constexpr arithmetic edit can use bounded warm rebuild
- layout-affecting constexpr edit is rejected with `constexpr_affects_layout`
- vendor template header edit is rejected with vendor boundary reason code
- Template Triage Agent proposal cannot bypass verifier rejection
- AI delta output can be rejected by deterministic verifier
- multi-role AI delta requires developer consent
- cold restart or state-loss fallback requires developer consent
- missing/stale toolchain capability profile blocks unsafe fast paths
- GPU driver TDR/device-taint prevents screenshot from being accepted as proof
- planned VRAM refresh is reported before predictable hard OOM
- unsupported incremental device-link reports vendor/toolchain reason

## Validation Harness Notes

Use `tmp/codex-next-gpu-hmr-scale-validation.md` for exact stack commands and
existing MCP scripts. The important automation loop is still:

```text
synthi_attach
synthi_compile
synthi_wait_hmr
synthi_screenshot
analyze screenshot visibility
edit device source
synthi_compile
synthi_wait_hmr
synthi_screenshot
compare before/after screenshot metrics
```

For production hardening, every run report should add:

- toolchainCapabilityProfileHash
- toolchainCapabilityProfile
- arbiterDecision
- rankedReloadOptions
- consentRequired
- consentReason
- agenticMode: `full_split` / `ai_delta` / `repair`
- attemptNumber
- source context hash
- model
- prompt schema version
- output artifact hash
- verifier failures
- repair diff summary
- compile result
- runtime result
- accepted/rejected
- fallback chosen
- warmPathEstimateMs and warmPathActualMs
- warmPathBudgetResult
- deviceLinkRequired
- deviceLinkEstimateMs and deviceLinkActualMs
- deviceLinkBudgetResult
- deviceLinkerBound
- templateEvidenceHash
- templateEvidenceStatus
- templateEvidenceInvalidationReasons
- templateArtifactFingerprintChanges
- templateTriageAgentDecision
- launchIndirectionTableVersion
- staleLaunchPointerChecks

Keep saving:

- first compile screenshot
- post-HMR screenshot
- worker/ai-engine log markers
- wall-clock time
- `synthi_wait_hmr.elapsedMs`
- git commit
- Docker image/container context

## Files To Inspect First In Next Session

Start with:

```text
docs/GPU_HMR_PROD_NEXT.md
tmp/codex-next-gpu-hmr-scale-validation.md
ai-backend/ai-engine/agents/kernel_splitter.py
ai-backend/ai-engine/verifier_gpu.py
ai-backend/ai-engine/build_manifest.py
backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs
mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
```

Also search for:

```text
.synthi_split_meta.json
toolchainCapabilities
templateEvidence
arbiterDecision
rankedReloadOptions
consentRequired
reloadPlan
device_only
gpu-reload
refactor/split/gpu
VerifiedAiRequest
compile_commands
```

## Suggested First Commits On New Branch

Keep patches small:

```text
docs(gpu-hmr): record prod orchestrator implementation notes
feat(gpu-hmr): add reload arbiter decision schema
feat(gpu-hmr): derive toolchain capability profile
test(gpu-hmr): block unsafe fast path without capability profile
feat(gpu-hmr): record hmr tier and consent policy
feat(gpu-hmr): add split attempt report schema
feat(gpu-hmr): gate generated split persistence on verifiers
feat(gpu-hmr): add generated role pollution verifier
feat(gpu-hmr): record agentic split attempts in sidecar
test(gpu-hmr): assert full split uses verifier loop
feat(gpu-hmr): classify mapped device body edits locally
test(gpu-hmr): reject signature and constant layout fast paths
feat(gpu-hmr): route launches through indirection table
test(gpu-hmr): reject stale launch pointers before reload
feat(gpu-hmr): collect template evidence for mapped kernels
test(gpu-hmr): reject stale template evidence for warm rebuild
feat(gpu-hmr): add template triage agent routing
feat(gpu-hmr): report rdc linker-bound reload paths
```

Do not start with multi-TU, Vulkan, full CMake generality, or broad
RDC/device-link support. Add the minimal capability and Arbiter contracts first
so later milestones can plug in without a rewrite.
