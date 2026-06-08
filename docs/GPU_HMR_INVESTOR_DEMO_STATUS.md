# GPU HMR Investor Demo Status

Updated: 2026-06-08

## Meeting-Ready Demo

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

## Fresh Ray-Traced GPU HMR Proof

Accepted proof from the current session:

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
- Visual inspection: before and after are nonblank ray-traced frames; the changed frame is visibly mirrored after the camera-rays shader math delta, and the amplified diff image is nonblank and high-signal.

Timing result:

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
- The demo-visible feedback time was `2.431s`, dominated by the ray-traced framebuffer run/capture, not by the HMR compile itself.
- The proof ran in the same process and accepted the changed framebuffer through pixel-backed visual evidence, not logs alone.

## Current Implementation Checkpoint

Recent committed GPU HMR proof hardening:

```text
d521ff5dc fix(gpu-hmr): require adversarial preflight proof
8a2c2ec69 fix(gpu-hmr): require explicit abi compatibility evidence
feccd384e fix(gpu-hmr): bind proof ledger history
9a2f45db7 test(gpu-hmr): seed investor demo workspace
83a13b634 docs(gpu-hmr): record investor demo proof
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
- The live MCP container has the current patch deployed after a container restart.

## Validation Completed In This Checkpoint

Local validation:

```text
npm --prefix mcp/synthi-mcp run build
npx vitest run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts mcp/synthi-mcp/tests/unit/gpu_proof.test.ts mcp/synthi-mcp/tests/unit/wait_hmr.test.ts
node mcp/synthi-mcp/scripts/gpu-hmr-proof-strict-gates-self-check.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-adversarial-proof-ledger-self-check.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-acceptance-contract-self-check.mjs
```

Result:

```text
MCP build passed.
344 focused unit tests passed.
Strict proof gates self-check passed.
Adversarial proof ledger self-check passed.
Acceptance contract self-check passed.
```

In-container validation after restart and MCP deploy:

```text
docker exec vectant-ade-mcp-1 node /app/scripts/gpu-hmr-proof-strict-gates-self-check.mjs
docker exec vectant-ade-mcp-1 node /app/scripts/gpu-hmr-adversarial-proof-ledger-self-check.mjs
docker exec vectant-ade-mcp-1 node /app/scripts/gpu-hmr-acceptance-contract-self-check.mjs
```

Result:

```text
All three checks passed in the MCP container.
The compose stack was back up with postgres, redis, and y-sweet healthy.
```

## Honest Remaining Work

The universal plan is not fully finished. The current ray-traced proof is strong for a HIPRT same-process visual path, and the proof ledger is materially stricter than the previous checkpoint, but production-grade universal GPU HMR still needs:

- First-class non-success routing evidence for host-only edits in GPU projects.
- More backend-specific acceptance probes across OpenCL, WebGPU/Bevy WGSL, and Vulkan pipeline/layout paths.
- Broader large-project validation beyond Flow and HIPRT.
- Full CI-grade strict real-ROCm validation after the new adversarial preflight gate is threaded through every runtime profile.
