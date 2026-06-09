# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-06-09

This document records the current implementation status against `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## Executive Status

Accepted local proof is ROCm/HIP on the AMD Radeon RX 9070 XT (`gfx1201`). CUDA was not validated on this machine.

The accepted proof set is broader than one fixture:

- strict ROCm/HIP full-runtime proof-ledger acceptance for generated HIP device artifacts,
- MCP preview visual HMR for generated ray-light and Flow workloads,
- HIPRT same-process ray-traced framebuffer HMR for CameraRays and MegaKernel direct-light profiles,
- ThreeJS external runtime visual proof as an external screenshot profile,
- negative/rejection evidence for Bevy and OIDN HIP where proof is missing or the runtime dependency is incompatible.

This is not yet production-grade acceptance for every arbitrary GPU project. The current accepted scope is ROCm/HIP plus the explicitly proven visual/runtime paths below. Non-HIP backends, CUDA, Vulkan, OpenCL, and Bevy/WebGPU full-runtime acceptance remain open.

## Hard Rules Preserved

- No hardcoded proof success paths were added.
- No shims were added.
- Docker proof runners now require explicit runtime configuration instead of baked-in endpoint/container/entry defaults.
- Visual evidence must be readable image artifacts; invalid image placeholders are rejected.
- Compute proof cards are supplemental unless the accepted target is compute-only and backed by deterministic output-oracle proof.
- One generated `.hip` file proves device-translation-unit HMR only; it does not prove per-kernel or smallest-safe fission.

## Accepted ROCm/HIP Runtime Ledger

Latest accepted strict runtime artifact:

```text
workspace: gpu-real-rocm-repo-20260609005300
gpu vendor: rocm
gpu arch: gfx1201
runtime proof id: gpu-runtime-proof:sha256:0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2
ledger proof id: gpu-ledger-proof:sha256:1cfa9927c27d63b9eadf4c96021f7d9270051519d822bfb55eb7b7f08b64b9eb
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260609005300-real-rocm-runtime-proof-0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
runtime proof limitations: []
output oracle: gpu-hmr-output-oracle-proven
```

Supplemental visual proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

The visual card was inspected with the local image viewer. It is readable and shows `Runtime Compute Output Oracle`, target `HIP-Basic/saxpy/main.hip:y`, generation 3, `PASSED`, with matching expected and actual GPU readback hashes.

Normalized timings from the accepted run:

```text
total validator wall: 235348.1968ms
AI contract synthesis: 73919.6076ms
model availability check: 1209.3515ms
device compile wall: 30372ms
runtime probe: 237ms
dispatch trace: 3ms
oracle analysis: 3ms
dispatch to output proof: 3ms
trigger to visible/output proof: 30001ms
```

After commit `92543192f`, the accepted runtime artifact was re-summarized through the patched summary builder:

```text
summary gpu_hmr_success: true
summary full_runtime_proven: true
summary limitations: []
summary ledger success: true
summary acceptance contract accepted: true
summary acceptance contract consistency accepted: true
```

Two later real-ROCm reruns were rejected, correctly:

- `gpu-real-rocm-repo-20260609010632`: worker runtime session was lost during hot delta.
- `gpu-real-rocm-repo-20260609011410`: first compile consumed the first-phase budget and no HMR proof was produced.

Those rejected attempts are not accepted proof.

## MCP Ray-Light Visual HMR

Accepted fresh MCP proof:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-rerun2
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:a4730f03c1b5da395ede415501e62b3152c2ea7d85394231739e2cd75a17d3c1
runtime proof id: gpu-runtime-proof:sha256:2f3ece89da76d997b47cebe0d65322234b59d49fbe61064fd10db9c84e17ce34
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=5.87%
mean_abs=10.01
control_changed=0.00%
control_mean_abs=0.32
selected_seq=993
selected_delta_ms=3734
```

Visual inspection confirmed a ray/light scene before HMR and a clearly changed light/ray bundle after HMR. The diff is nonblank and high-signal.

## MCP Flow Visual HMR

Accepted fresh MCP proof:

```text
workspace slug: flow-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-rerun2
fixture: flow
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:1de678f799fc420e489fbb4dcb5385d7f1621f47f2d78230cff3c60ed203800f
runtime proof id: gpu-runtime-proof:sha256:16d8756992bc28d03d8ed8dd1f5786b605b6c86cabc2ff2f6bc88681600ba6e9
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=2.59%
mean_abs=3.58
control_changed=0.00%
control_mean_abs=0.00
selected_seq=8038
selected_delta_ms=2098
```

Visual inspection confirmed a sparse particle ring before HMR and a gridded wave/field after HMR. The diff is nonblank and localized to the changed particle field.

## Generated Split Granularity

The accepted generated split claim is device translation unit HMR.

Flow:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: particle_flow, seed_kernel
rejected claims: smallest_safe_fission_island, per_kernel_hmr
reason: single generated translation unit contains multiple kernels
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Ray-light:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: trace_light_rays
rejected claims: smallest_safe_fission_island
reason: deterministic smallest-safe fission verifier not present
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

This answers the one-`.hip` concern: the current generated split proves hot reload at the generated device translation unit. It does not claim smaller fission.

## HIPRT Same-Process Visual HMR

HIPRT proof is separate from the MCP browser preview path. It proves same-process ray-traced framebuffer changes in the HIPRT path tracer checkout:

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

Fresh CameraRays proof:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:94182ab06e86ef8da8c359f43b2ad4589d3e71d88ec367b8ada0b2f9989f96c6
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013148-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013148-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013148-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013148-diff-amplified.png
changed pixels: 91.4019%
mean abs delta 8-bit: 53.1273
adapter build: 69487ms
same-process live recompile: 46ms
trigger wait: 323ms
edit to first visual: 2673ms
total validator wall: 302713.591ms
```

Fresh MegaKernel direct-light proof:

```text
profile: hiprt-megakernel-direct-light-zero
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:f881ef5c369ea0640ba0acc9ab6389ed927040e15d4a2eba6b2fff0057532984
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013659-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013659-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013659-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260609013659-diff-amplified.png
changed pixels: 41.8229%
mean abs delta 8-bit: 32.9462
adapter build: 9404ms
same-process live recompile: 82ms
trigger wait: 525ms
edit to first visual: 2370ms
total validator wall: 13908.9233ms
```

Visual inspection confirmed nonblank before/after/diff images. CameraRays shows a mirrored/recomposed Cornell-style framebuffer. MegaKernel direct-light shows a lighting contribution change with a high-signal diff.

## OIDN Status

OIDN was tested in the HIPRT checkout through a structured preflight artifact:

```text
proof id: oidn-preflight-proof:sha256:f5cf7bab766cfd7b13e1c0657818c20306e81cc9dda4267486771fc492e84f85
result state: oidn-hip-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-summary.txt
```

HIP device tests rejected:

```text
oidnTest 'device creation' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false

oidnTest 'buffer read/write' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false
```

Dependency check:

```text
libOpenImageDenoise_device_hip.so.2.3.0 -> libamdhip64.so.5 => not found
unsupported reasons: missing_dependency:libamdhip64.so.5, oidn_hip_buffer_read_write_failed, oidn_hip_device_creation_failed
```

CPU OIDN diagnostics passed:

```text
device creation: all tests passed, 8 assertions
buffer read/write: all tests passed, 27 assertions
```

No symlink, ABI shim, or library compatibility shortcut was added. Do not claim OIDN HIP output proof on this ROCm 7 worker.

## External Project Profiles

ThreeJS WebGL shader lava profile passed as an external runtime screenshot proof:

```text
profile: threejs-webgl-shader-lava
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1780961959963-report.json
proof id: external-visual-proof:44d6ee855658665be4472d688f58cc2212487282b087e9a3ae420baf3574a593
status: pass
chrome GPU: enabled
total: 14045.5857ms
build: 3663ms
runtime ready: 537ms
edit to runtime signal: 1215ms
edit to screenshot: 4355ms
visual diff: 196ms
changed pixel ratio: 28.3778%
mean abs delta 8-bit: 12.9297
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1780961950497.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1780961956056.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1780961959195.png
```

Bevy/WGSL profile built with real Rust GNU/w64devkit toolchain but remains rejected, not accepted.

Fresh rejection artifact:

```text
profile: bevy-wgsl-shader-material
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
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780961693506-report.json
status: fail
reason: gpu_hmr_proof_insufficient
required state: gpu-hmr-full-runtime-proven
observed result state: missing
```

This is a correct refusal, not an accepted arbitrary-project proof.

## Runtime And Preview State

Current local service check:

```text
vectant-ade-worker-1 Up
vectant-ade-mcp-1 Up, 127.0.0.1:9464->9464
vectant-ade-frontend-1 Up, 127.0.0.1:3000->3000
```

Preview HTTP checks:

```text
http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-rerun2 -> HTTP 200
http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-rerun2 -> HTTP 200
```

The Codex in-app Browser connector was available as a plugin, but `agent.browsers.list()` returned `[]`, so there was no `iab` browser backend to drive. Visual proof in this checkpoint uses persisted MCP screenshots and the local image viewer.

## Recent Commits

Proof/fix commits are separate:

```text
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
ff20d2d77 docs(gpu-hmr): record current proof status
072986aaa fix(gpu-hmr): keep compute proof cards supplemental
d600c7df3 fix(gpu-hmr): derive hip launch contract from runtime evidence
f8c82024c fix(gpu-hmr): normalize real rocm proof ledger inputs
220d95755 fix(gpu-hmr): validate full runtime artifact summaries
39832df72 fix(gpu-hmr): preserve degraded dispatch identity
```

## Verification Commands

Passed after the latest code fix:

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
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
SYNTHI_GPU_AGENT_MODE=seed-only SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=agent-split-archive-smoke-20260609-pass SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check
SYNTHI_OIDN_WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_OIDN_REPO_PATH=/tmp/synthi-real-rocm/HIPRT-Path-Tracer SLUG=oidn-hiprt-rocm-preflight-20260609 npm --prefix mcp/synthi-mcp run proof:oidn:preflight
node mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs --rejection-proof-from-report mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
```

Expected rejection command:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/app/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Remaining Work

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| ROCm/HIP generated runtime | Accepted full-runtime proof exists. | Keep rerun stability high; latest failed reruns must remain rejected. |
| Ray-light/Flow visual MCP | Accepted and visually inspected; agent-split summaries now archive under each slug artifact directory. | Keep top-level result files as latest-run convenience outputs only. |
| HIPRT | Fresh same-process CameraRays and MegaKernel proofs accepted. | Integrate HIPRT into the full MCP runtime ledger path if app hooks become available. |
| OIDN | CPU diagnostics pass; HIP backend rejected due `libamdhip64.so.5` dependency mismatch. | Use a matching OIDN HIP build for ROCm 7 or keep OIDN out of accepted HIP proof. No shims. |
| External projects | ThreeJS visual profile accepted; Bevy remains rejected. Latest run timed out with no decoded frames or visual oracle; an earlier strict gate rejected missing full-runtime proof. | Implement backend-specific full-runtime proof for Bevy/WebGPU before accepting it. |
| CUDA | Not tested on this AMD machine. | Validate only on CUDA hardware. |
| Narrow fission | Device translation unit HMR proven. | Add deterministic smallest-safe fission verifier before claiming per-kernel/smallest island. |
| Browser proof | Preview URLs are live; MCP screenshots exist. | In-app Browser backend was unavailable in this session. |

## Accepted Statement

```text
On the local AMD ROCm machine, Synthi can split generated ROCm/HIP GPU workloads, compile the device artifact with hipcc, hot-reload a device-only edit in a running preview/runtime, prove generated ROCm/HIP device artifacts with strict runtime-ledger acceptance, and provide separate pixel-backed visual evidence for Flow, ray-light, HIPRT, and external ThreeJS.
```

Do not claim:

```text
CUDA runtime proof was validated here.
Every arbitrary GPU project is production accepted.
The generated ray-light MCP fixture is HIPRT/OIDN.
OIDN HIP produced or validated the accepted output.
The one-file generated .hip split proves per-kernel or smallest-island fission.
Bevy/WebGPU has full-runtime proof-ledger acceptance.
```
