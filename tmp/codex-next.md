# Codex Next Session Handoff - GPU HMR / RX 9070 XT

Date: 2026-05-16

## Current State

- Repo: `C:\Users\polek\Downloads\test-agent\vectant-ade`
- Branch: `dev-raf`
- Host GPU: AMD Radeon RX 9070 XT
- ROCm arch used by the harness: `gfx1201`
- CUDA/NVIDIA path: added as an opt-in worker image + compose override.
  Use an NVIDIA host with NVIDIA Container Toolkit; current PC cannot live-run
  CUDA because it has the RX 9070 XT, not an NVIDIA GPU.
- Compose project: `vectant-ade`
- Current validated user demo workspace:
  - URL: `http://localhost:3000/workspace/gpu-flow-clean-session`
  - Slug: `gpu-flow-clean-session`
  - Browser settings: `GUI` on, `GPU` on, `HMR` on
  - Active file for the visible flip: `device.hip`

## Latest Commits To Know

- `4d1c1788 feat(gpu-hmr): add cuda worker compose path`
- `312ea251 fix(gpu-hmr): preserve manifest path in browser compile`
- `f3e76eb9 fix(gpu-hmr): send adapted files from browser`
- `3a27bf02 test(gpu-hmr): validate flow demo live`
- `859bf4be test(gpu-hmr): add particle flow validation`
- `76711305 docs(gpu-hmr): record abi classifier validation`
- `f62623ec fix(gpu-hmr): classify kernel abi changes`

Run this after a clean-session resume:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
git status --short
git log --oneline -8
```

## What Was Built This Session

GPU HMR now has two useful validation surfaces:

1. The original deterministic vector fixture:
   - Phases: `P0,P1,P2`
   - Validates device compiler dispatch, sidecar reload, snapshot/reuse telemetry, fast device-only swap, and ABI-breaking kernel-signature classification.

2. A new user-visible particle-flow fixture:
   - Phase: `FLOW`
   - Seeds an SDL2 GUI workspace with GPU-driven particles.
   - Baseline `device.hip` moves particles inward.
   - A device-only edit flips `FLOW_DIRECTION` to move particles outward.
   - Validates the live path through MCP: compile, wait HMR, screenshot, device-only GPU sidecar hot swap, render-loop outward telemetry, second screenshot.

The latest `FLOW` live run created `gpu-flow-clean-session` and passed:

```text
Checked 25: 22 PASS, 0 WARN, 0 FAIL, 3 SKIP
Phases: FLOW pass
[FLOW] inward GPU launch observed - synthi_gpu_launch kernel=particle_flow
[FLOW] outward device edit hot-swapped - [gpu-reload] plan=device_only
[FLOW] render loop reports outward flow - [gpu-flow-demo] ... trend=outward
```

## Important Files

- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs`
  - Main GPU HMR harness.
  - Contains the vector fixture and the new `FLOW` particle fixture.
  - Vendor switch:
    - ROCm: `SYNTHI_GPU_VENDOR=rocm`, active file `device.hip`
    - CUDA: `SYNTHI_GPU_VENDOR=cuda`, active file `device.cu`
  - Search anchors:
    - `SYNTHI_GPU_HMR_FIXTURE`
    - `FLOW_SHARED_H`
    - `FLOW_DEVICE_INWARD`
    - `FLOW_DEVICE_OUTWARD`
    - `phaseFlow`
    - `captureMcpScreenshot`

- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
  - Device kernel signature extraction.
  - Device manifest ABI stamping.

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`
  - GPU sidecar reload planner.
  - Tracks last accepted device ABI fingerprint.
  - Emits `plan=device_only` and `plan=abi_breaking`.

- `backend/synthi-webrtc-compiler/worker/Dockerfile.cuda`
  - CUDA/NVIDIA worker image.
  - Based on `nvidia/cuda:12.8.0-devel-ubuntu24.04`.
  - Provides `nvcc`, CUDA headers/libs, CUDA stub-library link path, Rust,
    SDL2, GStreamer, Xvfb, clangd, and Node.

- `docker-compose.nvidia.yml`
  - Opt-in compose override for NVIDIA hosts.
  - Replaces the worker build with `Dockerfile.cuda`.
  - Resets the ROCm `/dev/dxg` devices/volumes and exposes `gpus: all`.

- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.txt`
- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.json`
  - Latest committed harness result.

- `mcp/synthi-mcp/.gpu-hmr-test-artifacts/`
  - Runtime screenshots from `FLOW`.
  - Ignored by git on purpose.

## Start The Stack

From repo root:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade

docker-compose up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp
docker compose ps
```

The user-provided service list is intentional. Keep the stack up while testing live UI/MCP. Only run `docker compose down` when the user is done.

## Start The Stack On NVIDIA/CUDA

Host prerequisites:

- NVIDIA driver visible to Docker.
- NVIDIA Container Toolkit installed and working.
- For RTX 50 / Blackwell, use CUDA Toolkit 12.8+ and `SYNTHI_GPU_ARCH=sm_120`.

Build the CUDA worker:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml build worker
```

Start the stack with the NVIDIA override:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade

docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml ps
```

Verify the worker sees CUDA:

```powershell
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml exec worker sh -lc "nvidia-smi && nvcc --version && echo LIBRARY_PATH=$LIBRARY_PATH"
```

## Build Containers

Full compose build:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
docker compose build
```

Worker builder image for targeted Rust tests:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\backend\synthi-webrtc-compiler\worker

docker build --target builder --build-arg WORKER_CARGO_FEATURES=gpu-hmr -t synthi-worker-builder-gpu-hmr-test .
```

## Build MCP

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp
npm run build
```

## Run The User-Visible Flow Demo

Use this to create or revalidate a particle-flow workspace. If `SLUG` already exists and workspace creation fails, choose a new slug.

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp

$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='rocm'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SYNTHI_GPU_HMR_FIXTURE='flow'
$env:ONLY_PHASES='FLOW'
$env:SLUG='gpu-flow-clean-session'

node scripts/gpu-hmr-test.mjs
```

Expected result:

```text
FLOW pass
0 WARN
0 FAIL
```

Open in browser:

```text
http://localhost:3000/workspace/gpu-flow-clean-session
```

Manual UI settings:

- `GUI`: on
- `GPU`: on
- `HMR`: on
- Open `device.hip`

Manual visible flip:

```cpp
#define FLOW_DIRECTION 1.0f
```

Run/save: particles flow inward.

```cpp
#define FLOW_DIRECTION -1.0f
```

Save with HMR on: particles hot-swap outward.

Watch logs:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
docker compose logs -f worker
```

Expected good markers:

```text
[HMR] FallbackDeterministic -> split file edit (device.hip)
[compile-device] hipcc
[gpu-reload] plan=device_only
[gpu-flow-demo] ... trend=outward
```

Bad marker to investigate:

```text
[HMR] AI bypass: Proceed -> calling perform_ai_split
```

That means the worker did not detect the workspace as already adapted, or the user is not in the seeded workspace.

## Run The User-Visible Flow Demo On NVIDIA/CUDA

Use this on an NVIDIA host after starting with `docker-compose.nvidia.yml`:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp

$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='cuda'
$env:SYNTHI_GPU_ARCH='sm_120'  # RTX 50/Blackwell. Use sm_80/sm_90/etc. for older cards.
$env:SYNTHI_GPU_HMR_FIXTURE='flow'
$env:ONLY_PHASES='FLOW'
$env:SLUG='gpu-flow-cuda-session'

node scripts/gpu-hmr-test.mjs
```

Open in browser:

```text
http://localhost:3000/workspace/gpu-flow-cuda-session
```

Manual UI settings:

- `GUI`: on
- `GPU`: on
- `HMR`: on
- Open `device.cu`

Expected CUDA markers:

```text
[HMR] FallbackDeterministic -> split file edit (device.cu)
[HMR] compile_manifest: compiler=g++ ... gpu=cuda ...
[compile-device] nvcc
[gpu-reload] plan=device_only
Device sidecar reload vendor=cuda ... result=Success
```

## Run The Vector GPU HMR Validation

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp

$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='rocm'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SYNTHI_GPU_HMR_FIXTURE='vector'
$env:ONLY_PHASES='P0,P1,P2'

node scripts/gpu-hmr-test.mjs
```

Expected key markers:

```text
[P0] worker invokes device compiler - compile-device] hipcc
[P0] gpu adapter loaded cubin/hsaco - Device sidecar reload vendor=rocm ... result=Success
[P1] reload plan emitted - [gpu-reload] plan=mixed
[P2] fast swap within budget (300ms)
[P2] ABI edit emits abi_breaking cold reload - plan=abi_breaking
```

## Targeted Rust Tests

Run inside the builder image:

```powershell
docker run --rm synthi-worker-builder-gpu-hmr-test cargo test --release --features gpu-hmr device_kernel_ -- --nocapture

docker run --rm synthi-worker-builder-gpu-hmr-test cargo test --release --features gpu-hmr phase3_reload_reports_abi_breaking_when_kernel_signature_changes -- --nocapture
```

Expected:

- `device_kernel_`: 4 tests pass.
- ABI-breaking adapter test prints `plan=abi_breaking`, `cold_reload reason=abi_breaking`, and `device_on_load invoked`.

## Stop The Stack

Only when finished:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
docker compose down
```

## Commit Workflow

The user explicitly asked for frequent commits. Keep changes small and commit after each validated step.

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade

git status --short
git diff --stat
git add <files>
git commit -m "short(scope): precise description"
git status --short
git log --oneline -5
```

Do not commit ignored screenshot artifacts from `.gpu-hmr-test-artifacts/`. The latest result summaries in `.gpu-hmr-test-logs/` are tracked and may be committed when they document a validation run.

## Clean-Session First Actions

1. Read this file.
2. Run `git status --short`.
3. Run `docker compose ps`.
4. If stack is down, start it with the command above.
5. If asked to prove GPU HMR, run the `FLOW` command first because it validates the same path visually.
6. If asked for low-level correctness, run `P0,P1,P2` and the targeted Rust tests.
7. Commit any doc/result/code changes before handing back.
