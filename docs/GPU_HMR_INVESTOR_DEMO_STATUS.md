# GPU HMR Investor Demo Status

Updated: 2026-06-08

## Meeting-Ready Demo

Fresh workspace seeded:

```text
http://localhost:3000/workspace/investor-gpu-hmr-flow-20260608085052
```

Seed result:

- GPU vendor detected: ROCm, `gfx1201`.
- Fixture: Flow / inward-outward style GPU project seed.
- Source seeded as a normal single-file user GPU app, with no Synthi ABI prewired.
- Workspace seed used the validation fallback because `POST /api/workspace` returned `401 Authentication required`; the collab-backed seed path succeeded and committed `main.cpp`.
- Seed log: `mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-seed-results.txt`.

## Ray-Traced GPU HMR Proof

Accepted proof:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:e50b57249718bdf5cac6db60cf5ab547e10e674a5cc50bee419b74b5fb602984
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608055251-proof.json
```

Visual artifacts:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608055251-same-process-baseline-framebuffer.png
after:  mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608055251-same-process-changed-framebuffer.png
diff:   mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260608055251-diff-amplified.png
```

Visual result:

- Changed pixels: `91.4019%`.
- Mean absolute delta: `53.127` on 8-bit channels.
- Max channel delta: `255`.
- Visual inspection: before/after/diff are nonblank ray-traced frames; the scene visibly changes after the camera-rays shader math delta.

Timing result:

```text
total validator wall:          363.487s
same-process live recompile:     1.726s
same-process trigger wait:       0.537s
adapter build:                  72.794s
baseline framebuffer capture:   47.727s
changed framebuffer capture:    50.023s
edit-to-first-visual:           50.572s
```

Interpretation:

- The actual hot GPU artifact recompile in this run was `1.726s`.
- The demo-visible feedback time was dominated by the ray-traced framebuffer run/capture, not by the HMR compile itself.
- The proof ran in the same process and accepted the changed framebuffer through pixel-backed visual evidence, not logs alone.

## What Is Implemented Now

Recent committed GPU HMR proof hardening:

- `1ad8cc4d0 fix(gpu-hmr): prove model availability basis`
- `2f7e1f604 fix(gpu-hmr): bind screenshots to frame gates`
- `9ab13f88f fix(gpu-hmr): verify explicit ledger oracle sources`
- `a7cfd1028 fix(gpu-hmr): require pixel-backed visual oracle`
- `8c156bfd4 fix(gpu-hmr): require byte-backed compute oracle`

Implemented proof surfaces:

- Proof ledger rejects CPU HMR, full rebuild, process restart, stale artifacts, stale dispatch, missing output proof, invalid visual proof, and bad Gemini model provenance.
- Compute oracle proof is byte-backed through raw readback hash and deterministic slice verification.
- Visual oracle proof is pixel-backed through before/after/diff image hashes and recomputed pixel metrics.
- MCP screenshots are bound to `wait_hmr` frame-gate tokens, so a screenshot must be tied to the frame gate instead of just existing.
- Gemini model provenance now records model availability source, availability basis, and check time; opaque `provider_not_checked` model claims are rejected.
- Deployed MCP strict/adversarial proof checks passed after container restart.

## Honest Remaining Work

The universal plan is not fully finished yet. The next highest-risk engineering items are:

- Make proof ledger IDs bind the full normalized record and validate multi-record ledger history, not only the last record.
- Require explicit ABI compatibility evidence instead of allowing any path to default to compatible.
- Make adversarial preflight a required generic proof facet for every success artifact, not just scripts that choose to run it.
- Add first-class non-success routing evidence for host-only edits in GPU projects.

