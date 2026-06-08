# GPU HMR Investor Demo Status

Updated: 2026-06-08

## Meeting-Ready Position

There are two useful demo proofs available:

1. HIPRT same-process ray-traced framebuffer proof.
2. ROCm/HIP MCP preview proof for a generated visual ray-interaction workload.

The strongest investor-facing ray-tracing proof is the HIPRT same-process run. The strongest browser-preview proof is the ROCm/HIP MCP run because it goes through Synthi compile, wait-HMR, and screenshot tooling.

Safe claim:

```text
Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove the changed visual output with pixel-backed before/after/diff evidence.
```

Do not claim yet:

```text
Every arbitrary GPU project is production-grade accepted by the universal proof ledger.
CUDA runtime proof was validated on this AMD GPU.
The ROCm ray-interaction fixture is a full HIPRT/OIDN production path tracer.
```

## Fresh HIPRT Ray-Traced Proof

Accepted proof from the current checkpoint:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:a1090f3cf4ed52210089689d86733716fd64144c95499c70faf78dfc7b0788bf
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608062358-proof.json
```

Visual artifacts:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608062358-same-process-baseline-framebuffer.png
after:  mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608062358-same-process-changed-framebuffer.png
diff:   mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608062358-diff-amplified.png
```

Visual result:

- Changed pixels: `91.4019%`.
- Mean absolute delta: `53.127` on 8-bit channels.
- Max channel delta: `255`.
- Visual inspection: before and after are nonblank ray-traced frames; the changed frame is visibly mirrored after the camera-rays shader math delta; the amplified diff image is nonblank and high-signal.

Timings:

```text
total validator wall:          13.539s
same-process live recompile:    0.041s
same-process trigger wait:      0.423s
adapter build:                  9.355s
baseline framebuffer capture:   1.420s
changed framebuffer capture:    1.924s
edit-to-first-visual:           2.431s
```

Interpretation:

- The hot GPU artifact recompile in this run was `41ms`.
- Demo-visible feedback was `2.431s`, dominated by framebuffer run/capture.
- The proof is pixel-backed visual evidence, not logs alone.

## Browser Preview Workspace

Fresh workspace seeded:

```text
http://localhost:3000/workspace/investor-gpu-hmr-raytrace-20260608062358
```

Seed result:

- GPU vendor selected: ROCm, `gfx1201`.
- Fixture: Flow / inward-outward style GPU project seed.
- Source was seeded as a normal single-file user GPU app, with no Synthi ABI prewired.
- Workspace seed used the validation fallback because `POST /api/workspace` returned `401 Authentication required`; the collab-backed seed path succeeded and committed `main.cpp`.
- Seed log: `mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-seed-results.txt`.

## ROCm/HIP MCP Ray-Interaction Proof

Accepted proof from the MCP compile/wait/screenshot path:

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

Investor-facing artifacts copied from the accepted MCP run:

```text
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-hmr-first.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/after-hmr-first.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-after-diff.png
docs/gpu-hmr-investor-demo/ray-bounce-20260608/before-hmr-metadata.json
docs/gpu-hmr-investor-demo/ray-bounce-20260608/after-hmr-metadata.json
```

Timings from `mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-results.json`:

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

The hot visual feedback number to quote for this path is:

```text
device edit compile done -> MCP visual proof: 8.793s
HMR observed -> after-frame capture: 0.541s
```

## Current Implementation Checkpoint

Recent committed GPU HMR proof hardening from the pulled branch:

```text
d521ff5dc fix(gpu-hmr): require adversarial preflight proof
8a2c2ec69 fix(gpu-hmr): require explicit abi compatibility evidence
feccd384e fix(gpu-hmr): bind proof ledger history
9a2f45db7 test(gpu-hmr): seed investor demo workspace
83a13b634 docs(gpu-hmr): record investor demo proof
```

Additional current-session commits:

```text
4ca63096d fix(preview): open native gui widget while launch is pending
20a773893 fix(preview): request gpu split for gpu source runs
3a987dad5 test(gpu-hmr): render ray interactions in demo fixture
693155543 docs(gpu-hmr): record investor ray interaction proof
136b27b70 feat(gpu-hmr): add runtime profile proof controls
d0aa511d9 fix(ai): remove deprecated gemini preview default
```

Implemented proof surfaces now include:

- Proof ledger IDs bind the normalized proof record and multi-record ledger history.
- Runtime proof artifacts cannot report `gpuHmrSuccess=true` unless adversarial false-positive preflight evidence is present and accepted.
- Missing or malformed ABI compatibility class no longer defaults to `compatible`; it degrades to `unknown` and blocks acceptance.
- Proof ledger rejects CPU HMR, full rebuild, process restart, stale artifacts, stale dispatch, missing output proof, invalid visual proof, and bad Gemini model provenance.
- Compute oracle proof is byte-backed through raw readback hash and deterministic slice verification.
- Visual oracle proof is pixel-backed through before/after/diff image hashes and recomputed pixel metrics.
- MCP screenshots are bound to `wait_hmr` frame-gate tokens, so a screenshot must be tied to the frame gate instead of just existing.
- Gemini model provenance records model availability source, availability basis, and check time; opaque `provider_not_checked` model claims are rejected.

## Validation Completed In This Checkpoint

Pulled checkpoint validation:

```text
npm --prefix mcp/synthi-mcp run build
npx vitest run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts mcp/synthi-mcp/tests/unit/gpu_proof.test.ts mcp/synthi-mcp/tests/unit/wait_hmr.test.ts
node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-adversarial-proof-ledger-self-check.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-acceptance-contract-self-check.mjs
```

Result recorded by the pulled checkpoint:

```text
MCP build passed.
344 focused unit tests passed.
Strict proof gates self-check passed.
Adversarial proof ledger self-check passed.
Acceptance contract self-check passed.
```

The current working tree must be revalidated after merge-conflict resolution.

## Honest Remaining Work

The universal plan is not fully finished. Production-grade universal GPU HMR still needs:

- First-class non-success routing evidence for host-only edits in GPU projects.
- More backend-specific acceptance probes across OpenCL, WebGPU/Bevy WGSL, and Vulkan pipeline/layout paths.
- Backend-contract field-level evidence binding and consistency checks.
- Cross-binding between top-level proof ledger records and runtime proof artifacts.
- Deterministic visual proof enforcement for HIPRT, Vulkan, WebGPU, and Bevy visual backends.
- Broader large-project validation beyond Flow and HIPRT.
- Full CI-grade strict real-ROCm validation after the adversarial preflight gate is threaded through every runtime profile.
