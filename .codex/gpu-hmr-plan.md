# GPU HMR Implementation Plan

Reference: `docs/GPU_HMR_ULTRAPLAN.md`.

Correct product framing: Synthi does not hot-swap arbitrary CUDA/HIP source as-is. The agent rewrites GPU projects into a Synthi GPU runtime contract, keeps that ABI stable across edits, hot-swaps sidecar device modules, and preserves Synthi-managed GPU state. Runtime faults that poison the CUDA/HIP context may still require cold restart after source repair.

## Phase 0 - Baseline and Plan Alignment

Files:
- `.codex/gpu-hmr-plan.md`
- `docs/GPU_HMR_ULTRAPLAN.md`
- `mcp/synthi-mcp/scripts/gpu-hmr-phase*.sh`

Work:
- Record implementation plan.
- Update plan language to distinguish runtime-boundary helpers from bad wrapper kernels.
- Normalize GPU HMR shell harness line endings if needed.

Tests:
- `file mcp/synthi-mcp/scripts/gpu-hmr-phase*.sh`
- `TMPDIR=/tmp TMP=/tmp TEMP=/tmp python3 -m pytest -q tests/test_gpu_build_manifest.py tests/test_gpu_detect.py tests/test_kernel_splitter.py tests/test_verifier_gpu.py`

Expected markers:
- Python: `49 passed`
- Shell files: no `CRLF line terminators`

## Phase 1 - AI Engine GPU Contract Endpoints

Files:
- `ai-backend/ai-engine/main.py`
- `ai-backend/ai-engine/diff_patch_helpers.py`
- `ai-backend/ai-engine/llm/prompts.py`
- `ai-backend/ai-engine/agents/abi_stamper.py`
- `ai-backend/ai-engine/agents/gpu_mod_delta.py`
- `ai-backend/ai-engine/agents/gpu_error_triage.py`
- `ai-backend/ai-engine/agents/gpu_healer.py`
- `ai-backend/ai-engine/agents/launch_graph_extractor.py`
- `ai-backend/ai-engine/tests/test_gpu_*.py`
- `ai-backend/ai-engine/tests/test_kernel_splitter.py`

Work:
- Add `/refactor/split/gpu`, `/refactor/diff_patch/gpu`, `/refactor/heal/gpu`.
- Add reload-plan response schema and GPU edit validation for existing files only.
- Teach prompts that `synthi_gpu_launch(...)` and `synthi_gpu_*` lifecycle calls are required runtime ABI, while wrapper kernels and migration shim files are forbidden.

Tests:
- `cd ai-backend/ai-engine && TMPDIR=/tmp TMP=/tmp TEMP=/tmp python3 -m pytest -q tests/test_gpu_build_manifest.py tests/test_gpu_detect.py tests/test_kernel_splitter.py tests/test_verifier_gpu.py`
- Add and run focused endpoint/agent tests as files land.

Expected markers:
- `/refactor/diff_patch/gpu` returns `reload_plan`
- `/refactor/heal/gpu` returns existing-file edits or verifier rejection
- No verifier acceptance of `_safe`, `_v2`, `_fallback`, or new `.cu/.hip` files

## Phase 2 - Worker Device Build Scheduling

Files:
- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_device.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/ptxas_info_parser.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/mod.rs`

Work:
- Carry `device.cu`/`device.hip` through split/diff metadata.
- Schedule `compile_device_phase0` alongside host stages when `manifest.gpu` exists.
- Emit structured device artifact and diagnostics log lines.

Tests:
- `cd backend/synthi-webrtc-compiler/worker && CARGO_TARGET_DIR=/tmp/synthi-worker-target cargo test --features gpu-hmr --lib compiler::stages::compile_device -- --nocapture`
- `cd backend/synthi-webrtc-compiler/worker && CARGO_TARGET_DIR=/tmp/synthi-worker-target cargo test --features gpu-hmr --lib compiler::stages::ptxas_info_parser -- --nocapture`
- `cd backend/synthi-webrtc-compiler/worker && CARGO_TARGET_DIR=/tmp/synthi-worker-target cargo check --features gpu-hmr --lib`

Expected markers:
- `[compile-device] ... ok artifact=... diagnostics_kernels=...`
- No `ccache nvcc`, `ccache hipcc`, or `ccache clang-cuda`

## Phase 3 - Device Module Swap Fast Path

Files:
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_manager.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_stream_drain.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_shadow_arena.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_dirty_bit.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_reload_orchestrator.rs`

Work:
- Replace `GpuModuleAdapter::reload()` `Unsupported` path with driver-loaded device-only swap.
- Use module manager two-slot load/resolve/swap/unload sequence.
- Drain before unload/load and emit deterministic telemetry.
- Keep fallback to cold path when driver unavailable or context-invalidating runtime fault occurs.

Tests:
- `cd backend/synthi-webrtc-compiler/worker && CARGO_TARGET_DIR=/tmp/synthi-worker-target cargo test --features gpu-hmr --lib hmr::gpu_module_adapter hmr::gpu_module_manager hmr::gpu_stream_drain hmr::gpu_shadow_arena hmr::gpu_dirty_bit -- --nocapture`
- `bash mcp/synthi-mcp/scripts/gpu-hmr-phase2-rs-deep.sh`

Expected markers:
- `[gpu-reload] plan=device_only`
- `[gpu-reload] step=drain`
- `[gpu-reload] step=load`
- `[gpu-reload] step=verify`
- `[gpu-reload] plan=device_only total_ms=...`

## Phase 4 - Runtime Contract, State, and Guardrails

Files:
- `backend/synthi-webrtc-compiler/worker/src/runtime/plugin_contract.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/plugin_contract.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/capability.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/runner/validator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/device_snapshot.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/device_checkpoint_probe.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/gpu_runtime_watchdog.rs`

Work:
- Move GPU ABI into code/header-level contract, not just prompt text.
- Add runtime-boundary symbols for descriptor, save, restore, kernel hash, and launch.
- Add managed-state snapshot envelope and fatal fault classification.
- Add drain timeout and watchdog telemetry.

Tests:
- `cd backend/synthi-webrtc-compiler/worker && CARGO_TARGET_DIR=/tmp/synthi-worker-target cargo test --features gpu-hmr --lib hmr::device_snapshot hmr::state_snapshot::v2_tests -- --nocapture`
- Add contract layout tests for `HotApi` struct-size compatibility.

Expected markers:
- `gpu_snapshot_telemetry`
- `snapshot_tier=A|B`
- `gpu_runtime_error kind=stream_hang|fatal_context|recoverable`

## Phase 5 - Frontend Toggle and End-to-End Harness

Files:
- `synthi/src/app/workspace/[slug]/page.jsx`
- `synthi/src/hooks/useHMR.js`
- `synthi/src/services/compilerClient.js`
- `synthi/src/redux/*`
- `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs`
- `mcp/synthi-mcp/tests/fixtures/gpu/**`

Work:
- Add GPU mode state and propagate `prefer_gpu_pipeline`.
- Ensure harness seeds GPU fixture manifests and asserts worker log markers.
- Run Docker smoke only after unit and cargo tests pass.

Tests:
- `docker-compose up -d --force-recreate redis postgres y-sweet collab-server signaling-server ai-engine ai-gateway frontend worker coturn mcp`
- `cd mcp/synthi-mcp && SYNTHI_GPU_HMR=1 SYNTHI_GPU_VENDOR=cuda node scripts/gpu-hmr-test.mjs`
- Optional full rebuild: `docker compose build`

Expected markers:
- `Checked ... 0 FAIL`
- `P0 PASS`
- `P1 PASS`
- `P2-cuda PASS`
- ROCm row passes or skips only for missing toolchain/fake runtime not configured
