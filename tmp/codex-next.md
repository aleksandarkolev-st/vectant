# Codex Next Session Handoff - GPU HMR / RX 9070 XT

Date: 2026-05-16

## Current State

- Repo: `C:\Users\polek\Downloads\test-agent\vectant-ade`
- Branch: `dev-raf`
- Compose project: `vectant-ade`
- GPU host: AMD Radeon RX 9070 XT, visible to Docker Desktop/WSL through `/dev/dxg`
- ROCm target arch: `gfx1201`

## Latest Local Commits

- `f62623ec fix(gpu-hmr): classify kernel abi changes`
- `05c7257c docs(gpu-hmr): record compose build closeout`
- `d3ea6464 docs(gpu-hmr): update rx 9070 xt handoff`
- `7555e8f8 test(gpu-hmr): stabilize rocm p2 log assertions`
- `63158fd4 test(gpu-hmr): accept manifest module aliases`
- `c975d802 test(gpu-hmr): accept rocm sidecar reload marker`
- `947e8146 build(worker): add rocm lld libxml compat`
- `8918a2c4 test(gpu-hmr): normalize rocm device source`
- `f272f953 fix(gpu-hmr): carry manifest through mcp compile`
- `1ed9ce20 docs(gpu-hmr): record rocm wsl visibility`
- `83ecca30 build(worker): add rocm wsl gpu runtime`
- `52963c37 docs(gpu-hmr): record worker feature build`
- `5d312218 build(worker): enable gpu hmr feature in compose`
- `00ff4f9c test(gpu-hmr): auto-detect compose containers`

## What Changed In This Pass

- Worker compose/Docker path supports the Docker Desktop WSL ROCm shape:
  - `/dev/dxg` is passed to the worker.
  - `/usr/lib/wsl/lib/libdxcore.so` is mounted.
  - `HSA_ENABLE_DXG_DETECTION=1` is set.
  - Worker image includes ROCm HIP SDK, `hipcc`, `rocminfo`, ROCDXG, and the ROCm `lld`/`libxml2` compatibility fix.
- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs` now:
  - Uses current fixture lifecycle ABI signatures expected by the runner.
  - Logs and parses fixture buffer pointers plus runner `state_preserved: true`.
  - Uses timestamped worker-log checkpoints.
  - Reads full Docker `logs --since` windows for checkpoint searches, avoiding stdout/stderr ordering and tail aging problems.
  - Caps the post-compile `synthi_wait_hmr` terminal-event wait for GPU runs.
  - Requires the live ABI-shaped device edit to emit `plan=abi_breaking`, `cold_reload reason=abi_breaking`, or `device_on_load invoked`.
- Worker GPU ABI classification now carries per-kernel parameter-list signatures into the device `BuildManifest.abi_version`.
  - Device body-only edits keep the ABI fingerprint stable and continue using fast GPU sidecar swap.
  - Kernel parameter-list edits change the ABI fingerprint and the GPU module adapter emits `plan=abi_breaking` before the fast-swap path.
  - The adapter records the last accepted device ABI fingerprint so subsequent device reloads can compare manifests without using the host `prev_manifest`.

## Verified On This Machine

Build:

```powershell
cd mcp/synthi-mcp
npm run build
```

Result: passed.

Targeted Rust verification inside the worker builder image:

```powershell
docker build --target builder --build-arg WORKER_CARGO_FEATURES=gpu-hmr -t synthi-worker-builder-gpu-hmr-test .
docker run --rm synthi-worker-builder-gpu-hmr-test cargo test --release --features gpu-hmr device_kernel_ -- --nocapture
docker run --rm synthi-worker-builder-gpu-hmr-test cargo test --release --features gpu-hmr phase3_reload_reports_abi_breaking_when_kernel_signature_changes -- --nocapture
```

Result: build passed; `device_kernel_` ran 4 tests; ABI-breaking adapter test passed and printed `plan=abi_breaking`.

Focused ROCm P0/P1/P2 harness:

```powershell
cd mcp/synthi-mcp
$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='rocm'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:ONLY_PHASES='P0,P1,P2'
node scripts/gpu-hmr-test.mjs
```

Latest result:

```text
Checked 36: 30 PASS, 0 WARN, 0 FAIL, 6 SKIP
Phases: P0 pass, P1 pass, P2 pass
```

Result artifacts:

- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.txt`
- `mcp/synthi-mcp/.gpu-hmr-test-logs/results.json`

Key verified markers include:

```text
[preflight] hipcc in worker - /opt/rocm/bin/hipcc
[vendor:rocm] GPU toolchain gate - worker:/opt/rocm/bin/hipcc
[P0] worker invokes device compiler - compile-device] hipcc
[P0] gpu adapter loaded cubin/hsaco - Device sidecar reload vendor=rocm ... result=Success
[P1] reload plan emitted - [gpu-reload] plan=mixed
[P1] snapshot latency within 500ms - snapshot_ms=100 bytes=0.0MiB
[P1] 2nd-edit snapshot within tight budget (250ms) - snapshot_ms=100
[P2] fast swap within budget (300ms) - reload_ms=3
[P2] ABI edit emits abi_breaking cold reload - plan=abi_breaking
```

Worker ROCm visibility previously verified in the live worker:

```text
/opt/rocm/bin/hipcc
HIP version: 7.2.53211-e1a6bc5663
rocminfo reports gfx1201 / AMD Radeon RX 9070 XT
```

## Current Caveat

The P0/P1/P2 GPU HMR path is live for ROCm on this RX 9070 XT and the ABI-shaped edit now reaches the stricter `plan=abi_breaking` marker through MCP. Remaining work is P3 polish/healer/stream-hang coverage and richer ABI stamping for constant-memory layout drift.

## Final Closeout Commands

The user-requested repository-level Docker commands were run after the green harness commit:

```powershell
docker compose build
docker compose down
```

Result:

- `docker compose build` passed for `frontend`, `ai-engine`, `ai-gateway`, `mcp`, `y-sweet`, `signaling-server`, `collab-server`, and `worker`.
- `docker compose down` stopped and removed the compose services and default network.
