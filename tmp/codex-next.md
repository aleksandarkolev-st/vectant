# Codex Next Session Handoff — GPU HMR / RX 9070 XT

Date: 2026-05-15

## Current State

- Repo: `/mnt/c/Users/dev/Downloads/synthi-test/synthi-ide`
- Branch: `dev-raf`
- Latest local commits:
  - `07b11802 test(gpu-hmr): default rocm fixture to gfx1201`
  - `f88aa6ce test(gpu-hmr): drive harness through mcp compile`
  - `4aca9360 chore(gpu-hmr): quiet gpu build warnings`
- Push status: not pushed. `git push origin dev-raf` failed because this environment has no GitHub HTTPS credentials:
  - `fatal: could not read Username for 'https://github.com': No such device or address`

## What Changed Recently

- `mcp/synthi-mcp/src/tools/compile.ts`
  - `synthi_compile` now forwards:
    - `prefer_gpu_pipeline`
    - `gpu_mode`
- `mcp/synthi-mcp/src/server.ts`
  - MCP tool schema now advertises those GPU compile options.
- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs`
  - Defaults to Docker MCP transport, matching the CPU HMR live-test path.
  - Uses MCP `synthi_compile` / `synthi_wait_hmr` for live GPU validation instead of direct AI-engine POSTs.
  - Keeps direct AI fallback opt-in only via `SYNTHI_GPU_DIRECT_AI_FALLBACK=1`.
  - Disables metrics for the harness-spawned MCP subprocess by default to avoid `EADDRINUSE` on port `9464`.
  - ROCm fixture now defaults to `gfx1201`, the RX 9070 XT target. Override with `SYNTHI_GPU_ARCH`.

## Verified In This Environment

This environment has no `nvcc` or `hipcc` in the worker, so real GPU execution was not proven here.

Commands run:

```bash
cd mcp/synthi-mcp
npm run build
node scripts/release-smoke.mjs --image synthi-ide-mcp:latest
node scripts/gpu-hmr-test.mjs --self-check
SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=cuda node scripts/gpu-hmr-test.mjs
SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=rocm ONLY_PHASES=P0 node scripts/gpu-hmr-test.mjs
```

Results:

- MCP release smoke passed.
- GPU fixture self-check passed.
- CUDA harness: `12 PASS, 0 WARN, 0 FAIL, 11 SKIP`.
- ROCm P0 harness: `12 PASS, 0 WARN, 0 FAIL, 11 SKIP`.
- The SKIPs are expected here because the worker lacks `nvcc` / `hipcc`.

Do not claim real GPU HMR is working until a machine with a visible GPU and `hipcc` or `nvcc` runs non-skip P0/P1/P2 rows.

## RX 9070 XT Assumptions

- RX 9070 XT is RDNA4 and should use ROCm arch `gfx1201`.
- The harness now defaults ROCm to `gfx1201`.
- MCP itself is GPU-agnostic. It only drives the streamed window and compile/HMR channel.
- The real requirement is that the worker container can see the GPU and has ROCm/HIP installed, especially `hipcc`.

## Commands For User To Run On RX 9070 XT Machine

From repo root:

```bash
docker compose down
docker compose build
docker-compose up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp
```

Check services:

```bash
docker compose ps
curl -s localhost:3000/api/ready
curl -s localhost:1234/health
nc -z localhost 9000
```

Check ROCm/HIP visibility:

```bash
docker exec synthi-ide-worker-1 sh -lc 'command -v hipcc && hipcc --version'
docker exec synthi-ide-worker-1 sh -lc 'rocminfo | head -80 || true'
docker exec synthi-ide-worker-1 sh -lc 'ls -l /dev/kfd /dev/dri || true'
```

Run the GPU HMR harness:

```bash
cd mcp/synthi-mcp
SYNTHI_GPU_HMR=1 \
SYNTHI_GPU_VENDOR=rocm \
SYNTHI_GPU_ARCH=gfx1201 \
node scripts/gpu-hmr-test.mjs
```

If they only want a quick smoke first:

```bash
cd mcp/synthi-mcp
SYNTHI_GPU_HMR=1 \
SYNTHI_GPU_VENDOR=rocm \
SYNTHI_GPU_ARCH=gfx1201 \
ONLY_PHASES=P0 \
node scripts/gpu-hmr-test.mjs
```

## Logs To Ask User For

Ask for these files/outputs after they run:

```bash
cat mcp/synthi-mcp/.gpu-hmr-test-logs/results.txt
cat mcp/synthi-mcp/.gpu-hmr-test-logs/results.json
tail -300 mcp/synthi-mcp/.gpu-hmr-test-logs/mcp.stderr.log
tail -500 backend/synthi-webrtc-compiler/.run/worker.log
docker compose ps
docker logs --tail=300 synthi-ide-worker-1
```

If P0 fails, also ask for:

```bash
docker exec synthi-ide-worker-1 sh -lc 'command -v hipcc; hipcc --version; rocminfo | head -120; ls -l /dev/kfd /dev/dri'
```

## Expected Green Markers

For a real RX 9070 XT ROCm run, expected early markers include:

```text
[preflight] hipcc in worker — /path/to/hipcc
[preflight] MCP tools/list — transport=docker count=42
[vendor:rocm] GPU toolchain gate — worker:/path/to/hipcc
[compile-device] hipcc ...
[gpu-adapter] hipModuleLoad ok ...
```

For later phases, expected markers include:

```text
[gpu-reload] plan=device_only
[gpu-reload] step=drain
[gpu-reload] step=save
[gpu-reload] step=unload
[gpu-reload] step=load
[gpu-reload] step=restore
[gpu-reload] step=verify
gpu_snapshot_telemetry snapshot_ms=... snapshot_bytes=...
```

## Likely Failure Modes

- `hipcc not found`
  - Worker image does not include ROCm/HIP compiler.
  - Fix Dockerfile/image or mount ROCm toolchain into worker.
- `/dev/kfd` or `/dev/dri` missing
  - GPU device not passed into Docker.
  - Need ROCm Docker runtime/device flags for worker.
- `unsupported gpu architecture` or `unknown processor gfx1201`
  - ROCm version too old for RX 9070 XT / RDNA4.
  - Upgrade ROCm in worker image.
- MCP initialize fails with `EADDRINUSE 9464`
  - Should be fixed in the harness by default. If seen, ensure `MCP_PROMETHEUS_PORT` is unset or set to a free port.
- Harness all SKIP
  - Means no toolchain was visible. Not a GPU HMR success.

## Next Session Priorities

1. Read user-provided `results.txt`, `results.json`, `worker.log`, and Docker outputs.
2. If the harness still skips: fix worker ROCm/HIP visibility first.
3. If P0 fails after `hipcc` is visible: inspect `compile_device.rs` command line and ROCm arch handling.
4. If P0 passes but P1/P2 fail: inspect GPU adapter/reload logs and classify whether the failure is compile, module load, state snapshot, or reload orchestration.
5. Do not mark GPU HMR complete until ROCm P0, P1, and P2 have PASS rows on RX 9070 XT.

## Local Follow-up (2026-05-15, RX 9070 XT)

- Docker containers are running under compose project `vectant-ade`, so the old hard-coded names `synthi-ide-mcp-1` / `synthi-ide-worker-1` are stale on this checkout.
- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs` now auto-resolves active `mcp` and `worker` service containers through `docker compose ps -q` and compose service labels when the configured container names do not exist.
- Worker Docker builds now set `WORKER_CARGO_FEATURES=gpu-hmr` from compose, and the rebuilt `vectant-ade-worker:latest` runner no longer contains the `load_device ignored; runner built without gpu-hmr` fallback string.
- Verified host GPU: Windows reports `AMD Radeon RX 9070 XT`.
- Verified Docker Desktop GPU device shape: Docker can pass `/dev/dxg` into containers, but this environment does not expose native Linux `/dev/kfd` or `/dev/dri` to the worker.
- Verified WSL libraries: `/usr/lib/wsl/lib/libdxcore.so` exists in the Ubuntu WSL distro, but `/opt/rocm/lib/librocdxg.so` is not installed.
- Verified worker blockers:
  - `hipcc` not found
  - `rocminfo` not found
  - `/dev/kfd` and `/dev/dri` not present
- Latest ROCm P0 smoke:

```powershell
$env:SYNTHI_GPU_HMR='1'
$env:SYNTHI_GPU_VENDOR='rocm'
$env:SYNTHI_GPU_ARCH='gfx1201'
$env:ONLY_PHASES='P0'
node scripts/gpu-hmr-test.mjs
```

Result: `12 PASS, 0 WARN, 0 FAIL, 11 SKIP`.

The skip is still the expected blocker, not a GPU success:

```text
[vendor:rocm] GPU toolchain gate - no_toolchain: hipcc not found
[P0] toolchain smoke - no_toolchain: hipcc not found
```

For this Windows/WSL2 Docker Desktop host, the likely next infra step is a ROCDXG-compatible worker path: ROCm user-space with `hipcc`, `HSA_ENABLE_DXG_DETECTION=1`, `/dev/dxg` passed through, and mounts for `libdxcore.so` plus `librocdxg.so` once ROCDXG is installed. Native Linux `/dev/kfd` + `/dev/dri` compose flags alone will not work on the current Docker Desktop device model.
