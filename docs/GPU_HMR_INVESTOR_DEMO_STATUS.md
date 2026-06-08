# GPU HMR Investor Demo Status

Status date: 2026-06-08

## Current Demo Verdict

The deterministic ROCm/HIP ray-interaction GPU HMR demo is ready to show as a GPU HMR proof.

It should be described as:

```text
Synthi splits a monolithic GPU visual workload, builds a ROCm/HIP device artifact,
hot-reloads a device-only ray-interaction math edit into the still-running preview,
and proves the visible frame changed through MCP-captured before/after/diff images.
```

Do not describe this run as a full HIPRT/OIDN path tracer. It is a deterministic HIP/ROCm ray-interaction validation fixture designed for live proof: fixed camera, fixed scene, no temporal accumulation, no denoiser, and visual evidence captured through MCP.

## Accepted Run

```text
workspace slug: investor-ray-bounce-gpu-hmr-20260608
workspace url: http://localhost:3000/workspace/investor-ray-bounce-gpu-hmr-20260608
gpu vendor: rocm
gpu arch: gfx1201
fixture: ray-light
split model configured: gemini-3.5-flash
compile path: MCP synthi_compile
visual proof path: MCP synthi_screenshot before/after/diff
```

Accepted evidence:

```text
PASS first compile via MCP - use_ai_split=true prefer_gpu_pipeline=true
PASS worker used GPU split endpoint - GPU markers detected; calling GPU split endpoint
PASS generated device compiled - compile-device] hipcc
PASS mcp screenshot before hmr - 800x600 seq=72->88 visible=210097/210105
PASS device edit compile via MCP - .synthi/generated/gpu/device.hip
PASS generated device file used for HMR - FallbackDeterministic -> split file edit
PASS device-only GPU HMR observed - [gpu-reload] plan=device_only
PASS mcp screenshot after hmr - 800x600 seq=652->668 visible=210309/210289
PASS mcp screenshot visual delta - changed=5.89% mean_abs=10.03
PASS runner stayed alive after GPU HMR - no runner crash marker
```

## Visual Proof

Investor-facing artifacts copied from the accepted MCP run:

```text
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-hmr-first.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/after-hmr-first.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-after-diff.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-hmr-metadata.json
docs/gpu-hmr-investor-demo/ray-bounce-20260608/after-hmr-metadata.json
```

The before frame shows a light source, mirror/intersection, reflected ray bundle, ground hit band, diffuse bounce, and scene geometry. The after frame moves the ray interaction to the opposite side after a device-only math edit. The diff image shows both old and new ray paths.

## Timings

Derived from `mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-results.json` for the accepted run:

```text
total result wall: 286.709s
attach to first compile done: 181.059s
first compile done to before screenshot: 78.283s
first compile done to device edit compile done: 88.902s
device edit compile done to HMR observed: 8.223s
HMR observed to after screenshot: 0.541s
device edit compile done to visual proof: 8.793s
after screenshot to diff computation: 0.029s
visual proof to runner-alive check: 6.094s
```

The cold path includes workspace seeding, AI split, generated build, preview attachment, screenshot capture, generated split persistence, and device edit. The hot visual feedback number to quote is:

```text
device edit compile done -> MCP visual proof: 8.793s
HMR observed -> after-frame capture: 0.541s
```

## Browser Preview Status

The frontend was rebuilt and restarted after two generic preview fixes:

```text
4ca63096d fix(preview): open native gui widget while launch is pending
20a773893 fix(preview): request gpu split for gpu source runs
```

Native GUI runs now open the floating video widget while launch is pending, and GPU-mode Play requests AI split when the active source/dependencies contain GPU API or shader evidence. This is evidence-based routing, not a project-specific demo branch.

The stack was rebuilt/restarted after those changes:

```text
frontend: up on 127.0.0.1:3000
mcp: up on 127.0.0.1:9464
worker: restarted after rebuild
```

## HIPRT/OIDN Position

HIPRT is still the better long-term proof for a production ray tracer. OIDN should not be placed on the critical live validation path until it is cached/preseeded and deterministic proof controls are explicit.

Reason:

```text
OIDN is a denoiser/post-process. It can improve demo polish, but it can also
blur whether the observed visual delta came from the new GPU epoch unless the
proof freezes camera, seed, accumulation, denoising, and frame boundaries.
```

Recommended HIPRT live-demo path:

```text
same-process HIPRT profile, fixed scene/camera/seed, OIDN disabled or already cached,
framebuffer capture before/after/diff, and explicit proof that the recompiled
kernel dispatch produced the changed image.
```

Existing useful HIPRT commands are documented in `docs/GPU_HMR_FULL_RUNTIME_CORRECTNESS_PLAN.md`, especially:

```text
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
```

## What Not To Claim

Do not claim:

```text
Every arbitrary GPU project is production-grade accepted by the universal proof ledger.
The ray-bounce demo is a HIPRT/OIDN production path tracer.
CUDA runtime proof was validated on this AMD GPU.
```

Safe claim:

```text
The ROCm/HIP GPU HMR path is live for generated visual GPU workloads, with
same-preview device-only reload and MCP visual evidence.
```
