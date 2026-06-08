# GPU HMR Investor Demo Status

Updated: 2026-06-09

## Meeting-Ready Position

There are three useful proof surfaces for the investor demo:

1. HIPRT same-process ray-traced framebuffer proof.
2. ROCm/HIP MCP preview proof for generated ray-light visual HMR.
3. ROCm/HIP MCP preview proof for generated Flow visual HMR.

The strongest ray-tracing visual proof is HIPRT same-process. The strongest Synthi-preview proof is ray-light because it goes through MCP compile, strict wait-HMR proof gating, MCP screenshots, persisted before/after/diff artifacts, and runner-alive validation.

Safe claim:

```text
On the local AMD ROCm machine, Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove the changed output with strict runtime-ledger evidence plus pixel-backed visual before/after/diff artifacts.
```

Do not claim:

```text
Every arbitrary GPU project is production-grade accepted by the universal proof ledger.
CUDA runtime proof was validated on this AMD GPU.
The generated ROCm ray-light MCP fixture is HIPRT/OIDN.
OIDN produced or validated the accepted visual delta.
The current one-file generated .hip split proves per-kernel or smallest-island fission.
```

## Live Preview Targets

The local stack is running with frontend on `127.0.0.1:3000` and MCP on `127.0.0.1:9464`.

Open these for the demo:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-current
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-current
```

The Codex in-app Browser backend was unavailable in this session, so the current committed proof relies on MCP screenshot artifacts and local visual inspection of the persisted PNGs. The URLs above are still the working local preview launch points.

## HIPRT Ray-Traced Proof

HIPRT proof is not the MCP browser preview path. It is a same-process HIPRT path-tracer proof against the worker checkout:

```text
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

### CameraRays

Accepted proof:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:7a667c3e8174017f01839daf15afce8ed0f0909cb8398df4a78921908076d012
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608223510-proof.json
```

Visual artifacts:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608223510-same-process-baseline-framebuffer.png
after:  mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608223510-same-process-changed-framebuffer.png
diff:   mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608223510-diff-amplified.png
```

Visual result and timings:

```text
changed pixels: 91.4019%
mean abs delta 8-bit: 53.127
max delta: 255
adapter build: 85.788s
same-process live recompile: 58ms
trigger wait: 678ms
baseline framebuffer capture: 54.977s
changed framebuffer capture: 55.778s
edit to first visual: 56.249s
total validator wall: 424.146s
```

Visual inspection: the baseline and changed frames are nonblank Cornell-style ray-traced framebuffers with HDR background. The changed frame is horizontally mirrored/recomposed after the CameraRays edit, and the amplified diff is high-signal.

### MegaKernel Direct Light

Accepted proof:

```text
profile: hiprt-megakernel-direct-light-zero
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:23b2c93a2f449db09008e5e87bf04f182c9e7c06653e43658ff434c4b081bf20
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608224243-proof.json
```

Visual artifacts:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608224243-same-process-baseline-framebuffer.png
after:  mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608224243-same-process-changed-framebuffer.png
diff:   mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608224243-diff-amplified.png
```

Visual result and timings:

```text
changed pixels: 41.8229%
mean abs delta 8-bit: 32.946
max delta: 255
adapter build: 10.830s
same-process live recompile: 88ms
trigger wait: 566ms
baseline framebuffer capture: 1.411s
changed framebuffer capture: 2.040s
edit to first visual: 2.580s
total validator wall: 15.161s
```

Visual inspection: the changed frame collapses the lit scene area to black while preserving frame/background boundaries, matching the direct-light-zero kernel edit. The diff image captures the removed scene lighting.

OIDN status: the HIPRT checkout/build includes OpenImageDenoise files and libraries. For deterministic visual evidence, the accepted CameraRays profile explicitly sets `denoiserDisabled=true`, and the proof must not be represented as OIDN-validated output.

## ROCm/HIP MCP Ray-Light Proof

Accepted current proof from the MCP compile/wait/screenshot path:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-current
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-current
gpu vendor: rocm
gpu arch: gfx1201
fixture: ray-light
compile path: MCP synthi_compile
visual proof path: MCP synthi_screenshot before/after/diff
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:0ee551b56f8e3a2bed38e7f997ff148760478facfcd116e34efe5c9d154ac54d
runtime proof id: gpu-runtime-proof:sha256:9e7b78e1a22c61346894ffaa22c0f94db77c429a8709c38e4a0ee9ae386d9631
```

Accepted evidence:

```text
PASS first compile via MCP - use_ai_split=true prefer_gpu_pipeline=true
PASS worker used GPU split endpoint - GPU markers detected; calling GPU split endpoint
PASS generated device compiled - compile-device] hipcc
PASS generated split contains HMR ABI - shared.h, core.cpp, gui.cpp, host_runner.cpp, device.hip
PASS generated split HMR granularity - claim=device_translation_unit_hmr device_tus=1 device_roles=1 kernels=1 smallest_safe_fission=not_proven
PASS mcp wait_hmr proof gate - resultState=gpu-hmr-full-runtime-proven
PASS device edit compile via MCP - .synthi/generated/gpu/device.hip
PASS device-only GPU HMR observed - [gpu-reload] plan=device_only
PASS mcp screenshot visual delta - changed=5.88% mean_abs=10.00 control_changed=0.00% control_mean_abs=0.01
PASS runner stayed alive after GPU HMR - no runner crash marker
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

Visual inspection: the before frame shows the ray/light scene with a light source, beams, ground grid, and geometry. The after frame moves the light and ray bundle while keeping the scene rendered. The diff is nonblank and shows the old and new ray paths.

Hot-path timing derived from timestamped proof events:

```text
seed to first compile proof: 95.383s
first compile proof to device edit proof: 10.233s
device edit proof to HMR observed: 3.070s
HMR observed to after screenshot: 3.787s
device edit proof to visual delta proof: 6.987s
```

Quote for this path:

```text
device edit proof -> visual delta proof: 6.987s
HMR observed -> after-frame capture: 3.787s
```

## ROCm/HIP MCP Flow Proof

Accepted current artifact set:

```text
workspace slug: flow-gpu-hmr-proof-20260609-current
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-current
artifact directory: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-current/
runtime proof id reported by run output: gpu-runtime-proof:sha256:06331edc97584bc4919ea996a4ac38d27edfee792d7a54d7ea72feb91fcd7646
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

Visual inspection: the before frame renders a sparse particle-ring pattern. The after frame renders a gridded wave pattern. The diff is nonblank and covers the expected changed region.

Local first-frame recompute:

```text
changed_threshold4=7.76%
mean_abs_8bit=3.61
max=240
```

The current ray-light run overwrote `agent-split-results.*`, so Flow should be shown as persisted artifact proof unless a fresh per-slug result log is archived before the meeting.

## Strict ROCm/HIP Compute Ledger Proof

Strict full-runtime compute/readback proof:

```text
workspace: gpu-real-rocm-repo-20260608222512
proof id: gpu-runtime-proof:sha256:e013fbb2bb9b95927f78352684c2fdaa526622a726d3be11c0ee62ab4f8abd40
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260608222512-real-rocm-runtime-proof-e013fbb2bb9b95927f78352684c2fdaa526622a726d3be11c0ee62ab4f8abd40.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
limitations: []
```

Supplemental proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260608222512-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

Visual inspection confirmed the proof card is nonblank and records matching expected/readback checksums for the GPU output oracle.

## Current Implementation Checkpoint

Additional current-session proof-hardening commits:

```text
39832df72 fix(gpu-hmr): preserve degraded dispatch identity
220d95755 fix(gpu-hmr): validate full runtime artifact summaries
f8c82024c fix(gpu-hmr): normalize real rocm proof ledger inputs
d600c7df3 fix(gpu-hmr): derive hip launch contract from runtime evidence
072986aaa fix(gpu-hmr): keep compute proof cards supplemental
```

Implemented proof surfaces now include:

- Runtime proof artifacts cannot report `gpuHmrSuccess=true` unless the full runtime artifact summary is internally accepted.
- Real ROCm ledger inputs are normalized before strict proof acceptance.
- HIP launch-contract checks are derived from runtime evidence instead of static string shortcuts.
- Degraded dispatch identity is preserved instead of accidentally upgrading evidence.
- Compute proof cards remain supplemental and cannot satisfy visual proof by themselves.
- Generated split granularity explicitly rejects `smallest_safe_fission_island` and `per_kernel_hmr` when only a device translation unit is proven.

## Validation Completed In This Checkpoint

Accepted proof commands already run in this checkpoint:

```text
npm --prefix mcp/synthi-mcp run proof:real-rocm:warm
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs  # SYNTHI_GPU_AGENT_FIXTURE=flow
node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs  # SYNTHI_GPU_AGENT_FIXTURE=ray-light
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check
```

The external-profile status is not accepted arbitrary-project proof:

```text
Bevy report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780951937094-report.json
Bevy status: fail, connect ECONNREFUSED 127.0.0.1:8787
External visual self-check: status pass, but placeholder image artifacts report unsupported image format
```

## Honest Remaining Work

Production-grade universal GPU HMR still needs:

- fix invalid placeholder visual artifact acceptance in the external visual self-check,
- re-run actual external project profiles with a live MCP/browser attach path,
- archive per-slug result summaries so Flow results are not overwritten by later fixture runs,
- extend backend-specific acceptance to OpenCL, WebGPU/Bevy, and Vulkan,
- validate CUDA only on a CUDA-capable machine,
- continue refusing broad arbitrary-project claims until backend-specific runtime and visual proofs exist.
