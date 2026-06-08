# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-06-09

This document tracks the implementation against `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## Executive Status

The strongest accepted implementation path is now ROCm/HIP on the local AMD Radeon RX 9070 XT (`gfx1201`). It has:

- strict full-runtime ROCm/HIP proof-ledger acceptance for generated HIP device artifacts,
- MCP preview visual HMR proof for generated ROCm/HIP Flow and ray-light workloads,
- HIPRT same-process ray-traced framebuffer proof for two kernel paths,
- persisted before/after/diff visual artifacts and timings for the accepted demo paths.

Do not describe this as CUDA proof. CUDA was not validated on this AMD ROCm machine.

Do not describe this as every arbitrary GPU project being production accepted. The current proof set is broader than one fixture, but arbitrary-project coverage still has open gaps: the latest persisted Bevy MCP profile report failed during attach (`connect ECONNREFUSED 127.0.0.1:8787`), and the external visual self-check currently records tiny invalid-format placeholder images even though its status is `pass`.

## Current Accepted Proofs

### Strict ROCm/HIP Runtime Ledger

Accepted strict proof:

```text
workspace: gpu-real-rocm-repo-20260608222512
gpu vendor: rocm
gpu arch: gfx1201
proof id: gpu-runtime-proof:sha256:e013fbb2bb9b95927f78352684c2fdaa526622a726d3be11c0ee62ab4f8abd40
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260608222512-real-rocm-runtime-proof-e013fbb2bb9b95927f78352684c2fdaa526622a726d3be11c0ee62ab4f8abd40.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
limitations: []
```

The proof ladder includes source, ABI, artifact transport, epoch swap, dispatch safety, output oracle, artifact identity, and host-preservation stages. The visual proof card for this run is supplemental compute evidence, not the primary acceptance gate:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260608222512-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

Visual inspection confirmed that proof card is nonblank and reports matching expected and actual GPU readback hashes.

### MCP Ray-Light Visual HMR

Current active MCP proof result:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-current
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-current
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:0ee551b56f8e3a2bed38e7f997ff148760478facfcd116e34efe5c9d154ac54d
runtime proof id: gpu-runtime-proof:sha256:9e7b78e1a22c61346894ffaa22c0f94db77c429a8709c38e4a0ee9ae386d9631
hmr observed: [gpu-reload] plan=device_only
```

Persisted visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/generated-split-granularity.json
```

Visual result:

```text
validator visual delta: changed=5.88% mean_abs=10.00 control_changed=0.00% control_mean_abs=0.01 selected_seq=3183 selected_delta_ms=1599
local first-frame recompute: changed_threshold4=13.31% mean_abs_8bit=10.00 max=253
```

Visual inspection confirmed that the before frame renders a ray/light scene with ground grid, geometry, and light rays. The after frame visibly relocates the light and ray bundle while preserving the rendered scene. The diff image is nonblank and captures both old and new ray paths.

Derived timings from timestamped proof events:

```text
total recorded result span: 116.575s
seed to first compile proof: 95.383s
first compile proof to before screenshot: 3.783s
first compile proof to device edit proof: 10.233s
device edit proof to HMR observed: 3.070s
HMR observed to after screenshot: 3.787s
device edit proof to visual delta proof: 6.987s
visual delta proof to runner alive check: 3.847s
```

### MCP Flow Visual HMR

Current Flow artifact set:

```text
workspace slug: flow-gpu-hmr-proof-20260609-current
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-current
artifact directory: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/
```

Persisted visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/generated-split-granularity.json
```

The Flow result summary was overwritten by the later ray-light run, so the durable evidence is the artifact directory and metadata. Visual inspection confirmed that the before frame is a sparse moving particle ring, the after frame is a gridded wave pattern, and the diff image captures the changed region. Local recomputation over the first persisted before/after frames produced:

```text
changed_threshold4=7.76% mean_abs_8bit=3.61 max=240
```

The previously recorded run output for this slug reported the strict runtime proof gate as satisfied with runtime proof `gpu-runtime-proof:sha256:06331edc97584bc4919ea996a4ac38d27edfee792d7a54d7ea72feb91fcd7646`.

### HIPRT Same-Process Visual HMR

HIPRT proof is separate from the Synthi MCP browser preview path. It proves same-process ray-traced framebuffer changes in the HIPRT path tracer checkout:

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

CameraRays profile:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:7a667c3e8174017f01839daf15afce8ed0f0909cb8398df4a78921908076d012
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608223510-proof.json
changed pixel ratio: 91.4019%
mean abs delta 8-bit: 53.127
total wall: 424.146s
live recompile: 58ms
edit to first visual: 56.249s
```

MegaKernel direct-light profile:

```text
profile: hiprt-megakernel-direct-light-zero
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:23b2c93a2f449db09008e5e87bf04f182c9e7c06653e43658ff434c4b081bf20
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608224243-proof.json
changed pixel ratio: 41.8229%
mean abs delta 8-bit: 32.946
total wall: 15.161s
live recompile: 88ms
edit to first visual: 2.580s
```

Visual inspection confirmed nonblank before/after/diff images for both HIPRT profiles. The CameraRays change mirrors/recomposes the Cornell-style framebuffer. The MegaKernel direct-light change removes scene lighting and the amplified diff captures the removed direct-light contribution.

OIDN status: the HIPRT checkout and build contain OpenImageDenoise sources/libraries, but the accepted visual proof intentionally disables denoising for deterministic evidence where applicable. Do not claim OIDN produced or validated the visual delta.

## Generated Split Granularity

The accepted generated split claim is device translation unit HMR, not per-kernel HMR and not smallest-safe-fission-island HMR.

Flow granularity:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: particle_init, particle_flow
rejected claims: smallest_safe_fission_island, per_kernel_hmr
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/generated-split-granularity.json
```

Ray-light granularity:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: trace_light_rays
rejected claims: smallest_safe_fission_island
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-current/generated-split-granularity.json
```

This directly answers the narrow-artifact-fission concern: one generated `.hip` file can still be valid device-translation-unit HMR, but it is not proof of smaller fission islands. The docs and acceptance language must not claim otherwise.

## Current Runtime And Preview State

`docker compose ps` on 2026-06-09 showed the app stack up, including:

```text
frontend: 127.0.0.1:3000->3000
mcp: 127.0.0.1:9464->9464
worker: Up
postgres/redis/y-sweet: healthy or up
```

Working preview URLs for local manual/browser validation:

```text
http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-current
http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-current
```

The Codex in-app Browser connector was present but returned no available browser backend in this session (`agent.browsers.list()` returned `[]` and `iab` was unavailable). Visual proof in this checkpoint therefore used the local visual inspection tool on the persisted PNG artifacts, plus MCP screenshot artifacts generated by the validator.

## Recent Hardening Commits

Recent commits are separate proof/fix steps, not a single bundled patch:

```text
39832df72 fix(gpu-hmr): preserve degraded dispatch identity
220d95755 fix(gpu-hmr): validate full runtime artifact summaries
f8c82024c fix(gpu-hmr): normalize real rocm proof ledger inputs
d600c7df3 fix(gpu-hmr): derive hip launch contract from runtime evidence
072986aaa fix(gpu-hmr): keep compute proof cards supplemental
```

These changes are generic proof-ledger and runtime-evidence fixes. They do not hardcode one fixture, edge case, project, or visual scenario.

## Plan Coverage

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| Model availability gate | Implemented for current proof paths enough to reject opaque/deprecated provenance in strict checks. | Ensure every frontend/backend AI path records the same availability basis. |
| AI not authority | Runtime proof acceptance derives from static/runtime evidence, not AI claims. | Continue auditing any unverified AI-produced hints. |
| CPU/GPU HMR firewall | Strict gates reject CPU HMR, full rebuild, stale dispatch, stale artifact, missing output proof, and process restart signals. | Expand negative routing evidence for host-only edits in GPU projects. |
| Acceptance contract schema | Rust and JS proof gates now bind runtime artifact summaries, artifact identity, launch evidence, and ABI evidence for current ROCm/HIP paths. | Finish parity across non-HIP backends. |
| Grand fission engine | Generated ROCm/HIP path proves device translation unit HMR. | Do not claim smallest safe fission until a deterministic fission verifier proves it. |
| Epoch graft | Current strict proof binds epoch swap and dispatch evidence. | Generalize across HIPRT, OpenCL, WebGPU/Bevy, and Vulkan. |
| Adapter synthesis | HIP and HIPRT proof runners are working for accepted paths. | Unsupported opaque engines must fail loudly or require app hooks. |
| Deterministic visual oracle | Persisted MCP before/after/diff artifacts exist for Flow and ray-light; HIPRT same-process proof has framebuffer before/after/diff. | Fix invalid placeholder acceptance in external visual self-check artifacts. |
| Adversarial refusal harness | Strict self-checks and runtime gates reject known false positives in current path. | Make all negative cases first-class in every backend profile. |
| Timing normalization | Current docs record derived ray-light, strict ROCm, and HIPRT timings. | Emit one normalized monotonic schema across every validator. |
| Browser preview UX | Services are up and preview URLs are available. | Browser plugin backend was unavailable in this Codex session; manual browser verification remains separate. |

## Next Implementation Steps

1. Fix external visual self-check artifact acceptance so invalid-format placeholder images cannot pass as visual evidence.
2. Re-run actual external project profiles with a live MCP/browser attach path; Bevy currently has a persisted attach failure.
3. Add normalized timing output to the Flow runner so its result summary is archived per slug rather than overwritten by the next run.
4. Extend runtime-ledger acceptance to OpenCL, WebGPU/Bevy, and Vulkan without claiming proof before backend-specific evidence exists.
5. Keep CUDA explicitly out of accepted local claims unless validated on a CUDA-capable machine.

## Acceptance Position

Acceptable statement now:

```text
On the local AMD ROCm machine, Synthi can split generated ROCm/HIP GPU workloads, compile the device artifact with hipcc, hot-reload a device-only edit in a running preview/runtime, and prove the result with strict runtime-ledger acceptance plus pixel-backed Flow, ray-light, and HIPRT visual evidence.
```

Do not claim yet:

```text
Every arbitrary GPU project is production-grade accepted.
CUDA runtime proof was validated here.
The generated ray-light MCP fixture is HIPRT/OIDN.
The current one-file generated .hip split proves per-kernel or smallest-island fission.
```
