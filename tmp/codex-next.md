# Codex Next Session Handoff - GPU HMR / RX 9070 XT

Date: 2026-05-17

## Current State

- Repo: `C:\Users\polek\Downloads\test-agent\vectant-ade`
- Branch: `dev-raf`
- Host GPU: AMD Radeon RX 9070 XT
- ROCm arch used by the harness: `gfx1201`
- GPU worker image path: `Dockerfile.gpu` now ships both CUDA and ROCm/HIP
  toolchains in one prebuilt-capable image. Compose still needs a host-specific
  override because Docker exposes NVIDIA (`gpus: all`) and AMD WSL (`/dev/dxg`)
  devices differently.
- CUDA/NVIDIA path: use an NVIDIA host with NVIDIA Container Toolkit. The
  current PC cannot live-run CUDA because it has the RX 9070 XT, not an NVIDIA
  GPU.
- Compose project: `vectant-ade`
- UI GPU target preference now exists in settings and the workspace gear menu:
  `AUTO`, `CUDA`, `ROCM`. It is persisted in local UI prefs and sent as
  `gpu_mode` on compile requests. Existing adapted manifests still define the
  actual device source/vendor for that workspace.
- Current validated user demo workspace:
  - URL: `http://localhost:3000/workspace/gpu-flow-clean-session`
  - Slug: `gpu-flow-clean-session`
  - Browser settings: `GUI` on, `GPU` on, `HMR` on
  - Active file for the visible flip: `device.hip`

## Latest Commits To Know

- `a26b8661 feat(gpu-hmr): add user gpu target preference`
- `9c194158 test(gpu-hmr): add dynamic workspace harness`
- `16473c5d feat(gpu-hmr): support manifest role file paths`
- `f172e324 docs(gpu-hmr): note manifest-driven compile files`
- `7d19925a fix(gpu-hmr): derive adapted compile files from manifest`
- `6c22a9e0 feat(gpu-hmr): add universal gpu worker path`
- `9534144d docs(gpu-hmr): record cuda compose handoff`
- `4d1c1788 feat(gpu-hmr): add cuda worker compose path`
- `312ea251 fix(gpu-hmr): preserve manifest path in browser compile`

Run this after a clean-session resume:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
git status --short
git log --oneline -8
```

## What Was Built This Session

GPU HMR now has three useful validation surfaces:

1. The original deterministic vector fixture:
   - Phases: `P0,P1,P2`
   - Validates device compiler dispatch, sidecar reload, snapshot/reuse telemetry, fast device-only swap, and ABI-breaking kernel-signature classification.

2. A new user-visible particle-flow fixture:
   - Phase: `FLOW`
   - Seeds an SDL2 GUI workspace with GPU-driven particles.
   - Baseline `device.hip` moves particles inward.
   - A device-only edit flips `FLOW_DIRECTION` to move particles outward.
   - Validates the live path through MCP: compile, wait HMR, screenshot, device-only GPU sidecar hot swap, render-loop outward telemetry, second screenshot.

3. A dynamic-path GPU HMR fixture:
   - Script: `mcp/synthi-mcp/scripts/gpu-hmr-dynamic-workspace-test.mjs`
   - Generates randomized source paths for shared/core/gui/runner/device files
     plus helper headers under nonstandard directories.
   - Writes `.synthi/build_manifest.json` with `files` and `module_files`, so
     the browser and worker discover roles semantically instead of depending on
     hardcoded names like `core.cpp` or `device.hip`.
   - Validates through MCP compile + wait-HMR, then checks worker logs for the
     randomized device filename, GPU launch telemetry, device-only reload, and
     outward flow after the device edit.

The browser compile path now sends all manifest-declared files for adapted
workspaces. It reads `.synthi/build_manifest.json` or
`.synthi_split_meta.json::compile_manifest`, includes every `files` entry and
every `module_files` role path, and only falls back to the old 5-file contract
for older manifests.

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
    - Auto: `SYNTHI_GPU_VENDOR=auto` detects the worker GPU/toolchain.
    - ROCm: `SYNTHI_GPU_VENDOR=rocm`, active file `device.hip`
    - CUDA: `SYNTHI_GPU_VENDOR=cuda`, active file `device.cu`
  - Search anchors:
    - `SYNTHI_GPU_HMR_FIXTURE`
    - `FLOW_SHARED_H`
    - `FLOW_DEVICE_INWARD`
    - `FLOW_DEVICE_OUTWARD`
    - `phaseFlow`
    - `captureMcpScreenshot`

- `mcp/synthi-mcp/scripts/gpu-hmr-dynamic-workspace-test.mjs`
  - Dynamic GPU HMR harness.
  - Creates randomized workspace source names and helper libs.
  - Use when validating that compile/HMR does not depend on hardcoded adapted
    filenames.

- `synthi/src/app/workspace/[slug]/page.jsx`
  - Browser compile no longer treats the adapted GPU source set as a fixed
    hardcoded list.
  - It reads `.synthi/build_manifest.json` or `.synthi_split_meta.json`, uses
    `compile_manifest.files` and `compile_manifest.module_files`, and falls
    back to the current 5-file GPU split contract only for older manifests.

- `synthi/src/redux/uiSlice.js`
- `synthi/src/services/compilerClient.js`
- `synthi/src/app/workspace/TopNav.jsx`
- `synthi/src/components/SettingsPanelContent.jsx`
  - User-facing GPU target preference.
  - Persisted values: `auto`, `cuda`, `rocm`.
  - Sent to worker compile requests as `gpu_mode`.

- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs`
  - For AI full splits, `gpu_mode=cuda|rocm` adds a target preference prompt
    before calling ai-engine.

- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
  - Device kernel signature extraction.
  - Device manifest ABI stamping.

- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`
  - GPU sidecar reload planner.
  - Tracks last accepted device ABI fingerprint.
  - Emits `plan=device_only` and `plan=abi_breaking`.

- `backend/synthi-webrtc-compiler/worker/Dockerfile.gpu`
  - Universal GPU worker image intended for prebuilt releases.
  - Based on `nvidia/cuda:12.8.0-devel-ubuntu24.04`.
  - Provides `nvcc`, CUDA headers/libs, CUDA stub-library link path, ROCm/HIP
    SDK, `hipcc`, `rocminfo`, ROCDXG, Rust, SDL2, GStreamer, Xvfb, clangd,
    and Node.

- `backend/synthi-webrtc-compiler/worker/Dockerfile.cuda`
  - Older CUDA-only fallback image from the first NVIDIA pass. Prefer
    `Dockerfile.gpu` now.

- `docker-compose.nvidia.yml`
  - Opt-in compose override for NVIDIA hosts.
  - Uses the universal `Dockerfile.gpu` worker image.
  - Resets the ROCm `/dev/dxg` devices/volumes and exposes `gpus: all`.
  - Gives ai-engine `SYNTHI_GPU_VENDOR_HINT=cuda` so ambiguous GPU splits target
    the detected host path.

- `docker-compose.gpu-amd.yml`
  - Opt-in compose override for AMD/ROCm hosts using the universal GPU worker.
  - Exposes the Windows/WSL `/dev/dxg` bridge and `libdxcore.so`.
  - Gives ai-engine `SYNTHI_GPU_VENDOR_HINT=rocm`.

- `scripts/start-gpu-stack.ps1`
- `scripts/start-gpu-stack.sh`
  - Host-detecting stack launchers.
  - Select NVIDIA override when `nvidia-smi` works; select AMD override when
    `/dev/dxg` is visible; support `-Pull/--pull`, `-Build/--build`, and
    custom `SYNTHI_WORKER_GPU_IMAGE`.

- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.txt`
- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.json`
  - Latest committed harness result.

- `mcp/synthi-mcp/.gpu-hmr-test-artifacts/`
  - Runtime screenshots from `FLOW`.
  - Ignored by git on purpose.

## What Model HMR Uses

Most HMR paths use no model:

- Adapted split-file edits, deterministic HMR classification, Tier 0/Tier 1
  host reloads, and GPU device-only sidecar swaps are worker/runtime logic.
- The live GPU flow fixture's inward/outward device edit should stay on this
  non-model path and log `FallbackDeterministic -> split file edit`.

When HMR falls back to a full AI split, the worker calls ai-engine
`/refactor/split/verified`. That endpoint currently passes
`model=req.model or "gemini-3.1-flash-lite-preview"` into the Gemini provider.
The Gemini provider itself defaults `SYNTHI_GEMINI_MODEL` to the same model
when no explicit model is supplied. The compose env currently contains
`SYNTHI_AI_MODEL=gemini-3-flash-preview-preview`, but this is not the model
used by the verified split route unless a caller maps it into `req.model`.

The GPU-specific `/refactor/split/gpu` route also defaults to
`gemini-3.1-flash-lite-preview`.

## Start The Stack

From repo root:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade

.\scripts\start-gpu-stack.ps1
```

Linux/WSL equivalent:

```bash
cd /path/to/vectant-ade
scripts/start-gpu-stack.sh
```

For a prebuilt worker image:

```powershell
$env:SYNTHI_WORKER_GPU_IMAGE='registry.example.com/vectant-ade-worker-gpu:tag'
.\scripts\start-gpu-stack.ps1 -Pull
```

If you know the exact GPU arch, set it before starting so ai-engine can steer
new GPU split manifests:

```powershell
$env:SYNTHI_GPU_ARCH='gfx1201'  # RX 9070 XT
```

Manual/default AMD stack command still works on this PC:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade

docker-compose up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp
docker compose ps
```

The user-provided service list is intentional. Keep the stack up while testing live UI/MCP. Only run `docker compose down` when the user is done.

## GPU Target UI

The user can pick the desired GPU target without editing env vars:

- Workspace top-right gear menu -> `GPU Target` -> `AUTO`, `CUDA`, `ROCM`.
- Full Settings panel -> `GPU Target` -> `AUTO`, `CUDA`, `ROCM`.
- Top nav GPU pill shows the current target when GPU mode is enabled.

This setting is a compile-request preference. For already-adapted workspaces,
the manifest still controls the actual device file and vendor. For first-time
AI splits, the worker adds a target hint to the ai-engine split request when
`CUDA` or `ROCM` is selected.

## Start The Stack On NVIDIA/CUDA

Host prerequisites:

- NVIDIA driver visible to Docker.
- NVIDIA Container Toolkit installed and working.
- For RTX 50 / Blackwell, use CUDA Toolkit 12.8+ and `SYNTHI_GPU_ARCH=sm_120`.

Preferred launcher:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade
.\scripts\start-gpu-stack.ps1 -Pull
```

Build the universal GPU worker locally if no prebuilt image is available:

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

Verify ai-engine has the runtime hint:

```powershell
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml exec ai-engine sh -lc "echo vendor=$SYNTHI_GPU_VENDOR_HINT arch=$SYNTHI_GPU_ARCH_HINT"
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
$env:SYNTHI_GPU_VENDOR='auto'
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

## Run Dynamic-Filename GPU HMR Validation

Use this when validating that arbitrary workspace file names and helper libs
still compile and hot-reload. Choose a fresh `SLUG` if the workspace already
exists.

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp

$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='auto'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:SLUG='gpu-dynamic-clean-session'

node scripts/gpu-hmr-dynamic-workspace-test.mjs
```

Expected result:

```text
DYNAMIC pass
0 FAIL
```

Expected markers:

```text
[DYNAMIC] worker saw dynamic device filename
[DYNAMIC] inward GPU launch observed
[DYNAMIC] outward device edit hot-swapped
[DYNAMIC] render loop reports outward flow
```

## Run The User-Visible Flow Demo On NVIDIA/CUDA

Use this on an NVIDIA host after starting with `docker-compose.nvidia.yml`:

```powershell
cd C:\Users\polek\Downloads\test-agent\vectant-ade\mcp\synthi-mcp

$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='auto'
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
$env:SYNTHI_GPU_VENDOR='auto'
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
5. If asked to prove GPU HMR visually, run the `FLOW` command first.
6. If asked to prove arbitrary file names/dependencies, run the dynamic harness.
7. If asked for low-level correctness, run `P0,P1,P2` and the targeted Rust tests.
8. Commit any doc/result/code changes before handing back.
