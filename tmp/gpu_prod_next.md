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
  -> implement Milestone 0.5 first
  -> implement Milestone 1 direct device-body path next
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

Use careful wording:

```text
Good: ROCm/GLFW path validated.
Good: CUDA path exists but requires matrix validation.
Bad: GPU HMR is production-ready.
Bad: CUDA works in production.
```

## New Architecture To Implement

The next branch should start with the Agentic Split/Verify Orchestrator.

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
- full source context report
- runner isolation metadata

Backward compatibility rule:

```text
read old sidecar shape
  -> write new sidecar shape
  -> migrate known fields opportunistically
  -> if required fields are missing, keep existing flow working
  -> disable unsafe fast path
  -> fall back to AI delta or full re-split
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
feat(gpu-hmr): add split attempt report schema
feat(gpu-hmr): gate generated split persistence on verifiers
feat(gpu-hmr): add generated role pollution verifier
feat(gpu-hmr): record agentic split attempts in sidecar
test(gpu-hmr): assert full split uses verifier loop
feat(gpu-hmr): classify mapped device body edits locally
test(gpu-hmr): reject signature and constant layout fast paths
```

Do not start with multi-TU, Vulkan, full CMake generality, or RDC/device-link.
Those are later milestones. Build the metadata shape so they can be added
without a rewrite.
