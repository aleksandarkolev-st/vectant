# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-06-08

This document tracks where the current implementation stands against the GPU HMR Universal Acceptance and Proof Ledger plan discussed for `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## Executive Status

The system has a working GPU HMR demo path for generated ROCm/HIP visual workloads through the MCP compile/wait/screenshot flow. The most recent rebuilt-container Flow validation passed with device-only GPU HMR and MCP visual-frame evidence.

It is not yet complete as a universal production acceptance system. The strongest implemented path is still the generated ROCm/HIP split pipeline plus existing proof gates. The plan's broader production contract still needs the remaining backend-general ledger, deterministic visual oracle hardening, and first-class refusal harness coverage before it can honestly claim arbitrary GPU-project acceptance.

## Implemented And Demonstrated

- ROCm/HIP generated GPU split path from monolithic user source.
- Device-only generated artifact edit path through MCP.
- GPU sidecar reload path that avoids replacing the host process for accepted device-only edits.
- MCP `synthi_wait_hmr` and `synthi_screenshot` proof flow.
- Flow visual demo rerun after container rebuild on 2026-06-08.
- Runtime output showing the worker runner remained alive after GPU HMR.
- Existing full-runtime correctness plan artifacts in `GPU_HMR_FULL_RUNTIME_CORRECTNESS_PLAN.md`.
- HIPRT proof scripts and profiles exist, including same-process and camera-rays paths.

Recent Flow evidence after rebuild:

```text
workspace: post-rebuild-gpu-hmr-flow-20260608
gpu vendor: rocm
gpu arch: gfx1201
first compile: use_ai_split=true prefer_gpu_pipeline=true
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
hmr observed: [gpu-reload] plan=device_only
visual gate: 800x600 seq=153->169 visible=7560/7636 luma=9.5/9.5
runner: stayed alive after GPU HMR
```

Derived timings from that run:

```text
overall script wall: about 68.2s
cold split to first compile complete: about 59.7s
device edit compile complete to HMR observed: about 0.111s
device edit compile complete to screenshot proof: about 1.175s
```

## Current Investor-Demo Gap

The HIPRT path-tracer demo is currently blocked by an upstream dependency download before GPU HMR starts. The CMake configure step attempts to fetch OIDN from GitHub and received HTTP 504 during the latest rerun.

That failure is not a GPU HMR rejection, but it prevents using the full HIPRT path tracer as the live meeting demo unless the dependency is cached or the repo build is preseeded.

The safer investor demo path is a deterministic ROCm/HIP visual ray-light workload that:

- renders visible light beams on a ground plane,
- uses a GPU kernel for the ray/light math,
- runs in the existing Synthi preview stream,
- edits only the generated device artifact,
- changes beam origin or sweep math,
- proves the changed frame through MCP screenshot evidence,
- reports hot edit timing separately from cold split timing.

## Plan Coverage

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| Model availability gate | Partially designed in docs; not fully enforced everywhere. | Replace old preview model defaults in all frontend/backend AI paths and ledger every model call. |
| AI not authority | Partially represented in proof planning and runtime evidence gates. | Ensure all accepted contract fields are static/runtime verified and AI fields remain hints. |
| CPU/GPU HMR firewall | Partially implemented in runtime proof logic. | Make every acceptance ledger explicitly prove `cpu_hmr_used=false`, `full_rebuild_used=false`, and `process_restarted=false`. |
| Acceptance contract schema | Rust contract work exists. | Finish schema parity with backend-specific ABI, reload, state, epoch, and failure-mode fields. |
| Grand fission engine | Device-only generated split path works for ROCm/HIP demos. | Generalize fission island selection from verified contracts across HIP, HIPRT, OpenCL, WebGPU/Bevy, Vulkan. |
| Epoch graft | HIP sidecar reload proof exists for generated path. | Make ledger-driven epoch publish/dispatch/output/retirement proof mandatory across backends. |
| Adapter synthesis | HIP/HIPRT scripts exist. | Fail loudly for unsupported non-interposable launch boundaries and require app hooks for opaque engines. |
| Deterministic visual oracle | MCP screenshot gate exists. | Add fixed seed, frozen camera, TAA/denoiser controls, presentation fence, and convergence windows for temporal renderers. |
| Adversarial refusal harness | Planned and partially represented in tests. | Make negative refusal cases the first mandatory validator phase. |
| Timing normalization | Flow timings can be derived; some scripts report detailed metrics. | Emit one monotonic timing schema for Flow, ray-light, HIPRT, ROCm compute, Bevy, OpenCL, Vulkan. |
| Browser preview UX | Floating GUI widget exists; docked Preview panel was still a stub at this checkpoint. | Wire preview panel to live GUI media stream and make Run/Preview behavior visible for demos. |

## Next Implementation Steps

1. Restore a concrete universal-plan file in `docs/` if it is missing from the checkout, or mark this status document as the current implementation tracker.
2. Fix the docked Preview panel so it renders the current native GUI stream instead of always saying `No preview available`.
3. Add a deterministic ROCm/HIP ray-light visual fixture to the MCP GPU HMR demo runner.
4. Rebuild/restart containers after the UI/demo changes.
5. Run the ray-light demo through MCP: cold split, device-only HMR, screenshot proof, runner-alive proof, timings.
6. Keep the HIPRT path as a high-value proof target, but preseed or cache OIDN before using it in a live meeting.
7. Continue implementing the universal proof ledger and adversarial refusal harness before broad production claims.

## Acceptance Position

Acceptable investor statement today:

```text
The ROCm/HIP GPU HMR path is live for generated visual GPU workloads: Synthi can split a monolithic GPU app, compile the device artifact, hot-reload a device-only edit in the same running preview, and prove the visual frame advanced after HMR.
```

Do not claim yet:

```text
Every arbitrary GPU project is production-grade accepted by the universal proof ledger.
```

That claim requires the remaining ledger, adversarial, backend-specific, and deterministic visual oracle work above.
