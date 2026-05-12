# Plan — Extend Vectant/Synthi HMR to CUDA & ROCm GPU Kernels

## 1. Context

Synthi's HMR pipeline today does Next.js-style hot-reload for compiled C++ host code. Concretely:

- The AI splits user code into 4 files (`shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`) and emits an architectural overview + a `BuildManifest` (JSON) inside `<synthi_arch_cache>` / `<synthi_build_manifest>` tags. Endpoint: `POST /refactor/split/verified` — `ai-backend/ai-engine/main.py:1527`. Schema: `ai-backend/ai-engine/build_manifest.py:79`.
- The Rust worker compiles each module with `g++`/`clang++` using `compile_to_object_command` + `link_object_to_so_command` (`backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_helpers.rs:188,227`), `dlopen`s the result via `libloading::Library::new(path)` (`backend/synthi-webrtc-compiler/worker/src/runtime/loader.rs:98`), and runs the v2 HotApi swap algorithm: same-version copy / msgpack migrate / cold-init (`backend/synthi-webrtc-compiler/PLUGIN_ABI.md:567-730`).
- On every edit, `POST /refactor/diff_patch` (`main.py:1919`) returns a list of `{module, operation, anchor, content}` edits (`diff_patch_helpers.py:53,94-96`); the worker re-compiles only the dirty module and re-runs the swap.

The user wants this same loop for **GPU kernels** — both **CUDA (nvcc/clang-cuda)** and **ROCm (hipcc)** from day one — with **full device-state preservation**, ideally via a binary device snapshot, and with the **error-healing loop** that exists for host compile errors extended to nvcc/hipcc/ptxas warnings and GPU runtime faults — **without introducing any shim/wrapper code**. The healer must natively patch existing modules; "agentic" means the AI updates the kernel and its lifecycle functions directly.

A targeted exploration of the codebase confirms there is **zero GPU plumbing today** (no `nvcc`, `hipcc`, `__global__`, or CUDA include references anywhere). This is greenfield. There is no `cuda-hmr` branch yet — work starts from `main`.

## 2. Feasibility verdict

The current pipeline cannot ship GPU HMR as-is. Four real blockers, all grounded in the actual code:

1. **Compiler enum is closed.** `ai-backend/ai-engine/build_manifest.py:57` defines `Compiler = Literal["g++", "clang++"]` and `validate_manifest_v1` (`build_manifest.py:173-177`) hard-rejects anything else. The Rust mirror in `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs:114-128` only knows two `Compiler` variants. There's no slot to put `nvcc`/`hipcc`.
2. **Build pipeline produces one host `.so` per slot.** `compile_helpers.rs:188-246` emits a single `.so` with `-shared` linking. There's no second artifact (cubin/hsaco) and no concept of a device-side module slot.
3. **State snapshot is host-only and JSON-shaped.** `worker/src/hmr/state_snapshot.rs:34` carries `payload: serde_json::Value`; the v2 HotApi runtime path uses msgpack via `save_state_msgpack_*` (`PLUGIN_ABI.md:608-613`) — both are CPU-RAM only. Device buffers, `__constant__` memory, streams, and in-flight launches are unaddressable.
4. **HotApi v2 assumes one address space.** `init/tick/render/event/migrate` take a `void* state` allocated by the runner (`PLUGIN_ABI.md:660-695`). CUDA contexts and HIP streams are opaque driver handles owned across module boundaries — they must outlive any cubin swap, which the current adapter has no concept of.

The architecture is *capable* of being extended cleanly — every blocker maps to a known seam, and the device-side hot-swap primitive already exists in both vendors:

- **CUDA**: `cuModuleLoadData` / `cuModuleUnload` (Driver API) atomically replaces a PTX/cubin without tearing down the context.
- **ROCm**: `hipModuleLoad` / `hipModuleUnload` is the direct analogue.

For binary device snapshots: **CUDA 12.5+** ships `cuCheckpointProcess{Lock,Checkpoint,Restore}`, a true binary process-state checkpoint. **ROCm** has experimental `criu-amdgpu`. Both must be probed at runtime; we always need a userspace fallback (drain streams, `cuMemcpyDtoH` every live allocation, replay on restore) for older drivers.

## 3. Goal

Ship a `cuda-hmr` branch that lets a user write a project containing `__global__`/`__device__` kernels (CUDA or HIP) and:

1. The AI splits the project into the existing 4 host files **plus** a 5th `device` file containing the kernels.
2. The worker builds host modules with `g++/clang++` and the device module with `nvcc`/`hipcc` into a sidecar `.cubin`/`.hsaco`.
3. On every edit, the GPU mod-delta agent classifies the diff as host-only / device-only / mixed / abi-breaking, and the worker performs the right kind of swap (host `.so` via `dlopen`, device cubin via `cuModuleLoad`, both, or cold reload) without restarting the process.
4. Device state survives the swap via driver-level checkpoint (preferred) or userspace serialization (fallback).
5. Compile errors *and* GPU-specific soft warnings *and* runtime faults all feed the same agentic healer — which natively patches existing modules, never emits shims/wrappers.

The work fits behind the existing v2 HotApi by adding a v2.1 GPU addendum; non-GPU projects are unaffected because every GPU field is optional.

## 4. Shape of the change

```
       ┌─────────────────────────────────────────────────────────────┐
       │  USER EDIT / FIRST COMPILE                                  │
       └────────────────────────┬────────────────────────────────────┘
                                │
                  ┌─────────────▼──────────────┐
                  │ GPU Project Detector       │ regex over source,
                  │ (no LLM, gpu_detect.py)    │ no LLM cost
                  └────────┬───────────┬───────┘
                  host-only│           │gpu
                           │           │
                ┌──────────▼──┐  ┌─────▼────────────────────┐
                │ existing    │  │ Kernel Splitter Agent    │ 5-file split:
                │ split_      │  │ (GPU_SPLIT_PROMPT)       │ +device.cu/.hip
                │ verified    │  │ emits manifest.gpu       │ +launch graph
                └──────────┬──┘  └─────┬────────────────────┘ +ABI hashes
                           │           │
                           ▼           ▼
                ┌─────────────────────────────────────────┐
                │ Rust worker: build manifest in sidecar  │
                │ select_compiler(manifest, kind):        │
                │   host     → g++/clang++  (ccache)       │
                │   device   → nvcc/hipcc   (no ccache)    │
                │ produces:  libcore.so + libgui.so +     │
                │            host_runner + device.cubin    │
                │ + ptxas_info_parser → diagnostics       │
                └────────────────────┬────────────────────┘
                                     │
                                     ▼
                ┌─────────────────────────────────────────┐
                │ Runtime: HotApi v2 + GPU adapter        │
                │ host: libloading::Library::new          │
                │ device: cuModuleLoadData / hipModuleLoad│
                │ + stream callbacks + watchdog →         │
                │   runtime_error channel                 │
                └────────────────────┬────────────────────┘
                                     │ user edits a file
                                     ▼
                ┌─────────────────────────────────────────┐
                │ Mod-Delta Classifier (Python, no LLM)   │
                │ diff → reload_plan ∈                    │
                │   host_only | device_only | mixed |     │
                │   abi_breaking                          │
                └────┬───────────────┬───────────────┬────┘
                     │host_only      │device_only    │mixed/abi
                     ▼               ▼               ▼
              ┌──────────┐   ┌──────────────┐  ┌──────────────────────┐
              │existing  │   │GPU Mod-Delta │  │GPU Mod-Delta Patcher │
              │/diff_    │   │Patcher (LLM) │  │+ host /diff_patch    │
              │patch     │   │device-only   │  │  (parallel calls)    │
              └────┬─────┘   └──────┬───────┘  └──────────┬───────────┘
                   │                │                     │
                   └────────────────┴─────────────────────┘
                                    │
                                    ▼
                ┌─────────────────────────────────────────┐
                │ Reload orchestrator:                    │
                │   host_only    → existing dlopen swap    │
                │   device_only  → device_swap()           │
                │   mixed        → save → host swap →      │
                │                  device swap → restore   │
                │   abi_breaking → cold reload + on_load   │
                │                                         │
                │ Snapshot tier: driver_checkpoint        │
                │   if probe finds CUDA≥12.5 / criu-amdgpu│
                │   else userspace tier (always works)    │
                └────────────────────┬────────────────────┘
                                     │ on nvcc/hipcc/ptxas error
                                     │ or runtime fault / hang
                                     ▼
                       ┌──────────────────────────────┐
                       │ GPU Error Triage (no LLM) →  │ unified
                       │ /refactor/heal/gpu →         │ payload,
                       │  GPU_HEAL_COMPILE_PROMPT  or │ tier-specific
                       │  GPU_HEAL_PERF_PROMPT     or │ sub-prompt,
                       │  GPU_HEAL_RUNTIME_PROMPT     │ verifier_gpu
                       └──────────────────────────────┘ rejects shims
```

## 5. Architectural changes

### 5.1 BuildManifest extension (`ai-backend/ai-engine/build_manifest.py`)

Add a sibling vendor-neutral GPU block. Existing host-only manifests are unchanged because every field is optional.

```python
# at line 55-58, alongside Compiler / HotReloadMode
DeviceCompiler = Literal["nvcc", "clang-cuda", "hipcc"]
DeviceVendor   = Literal["cuda", "rocm"]
SnapshotMode   = Literal["driver_checkpoint", "userspace", "auto"]

class GpuBuildBlock(BaseModel):
    vendor: DeviceVendor
    device_compiler: DeviceCompiler
    arch: List[str]                  # ["sm_80","sm_90"] | ["gfx90a","gfx1100"]
    device_flags: List[str]          # ["-O3","--use_fast_math","-lineinfo"]
    runtime_libs: List[str]          # ["cudart","cuda"] | ["amdhip64"]
    snapshot_mode: SnapshotMode = "auto"
    # sidecar_module is the only HMR-compatible strategy; embedded fatbin
    # is rejected by validate_manifest_v1 because it can't be hot-swapped.
    fatbin_strategy: Literal["sidecar_module"] = "sidecar_module"

class BuildManifest(BaseModel):     # at line 79, add one optional field
    # ... existing fields ...
    gpu: Optional[GpuBuildBlock] = None
```

Mirror the same shape in `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs` as a sibling `GpuBuildBlock` with `#[serde(default, skip_serializing_if = "Option::is_none")] pub gpu: Option<GpuBuildBlock>` on `CompileManifest`. Existing serde defaults keep host-only sidecars deserializing unchanged.

### 5.2 ABI addendum — primarily a prompt change

The plugin ABI is **defined by the split prompt**, not a Rust enum. `UNIVERSAL_SPLIT_PROMPT` (`prompts.py:2872`) is what tells the AI to emit `core_on_load`, `gui_on_load(prev, renderer, core_api)`, the `CORE_STATE_MAGIC`/`GUI_STATE_MAGIC` headers, the `hot_get_api()` single export, the size-then-write msgpack serializers, and so on. The Rust side is thin:

- `runtime/plugin_contract.rs:7-22` declares the *runtime view* of the `HotApi` struct (so the worker can decode what `hot_get_api()` returns).
- `runtime/loader.rs:307-310` does the dlopen + `hot_get_api` probe.
- `runtime/runner/validator.rs:17-53` checks for the legacy named exports (`core_on_load`, `gui_on_load`, `gui_on_render`, …).
- `runtime/capability.rs:91-168` records which optional symbols a module exposes.

So the GPU addendum is primarily a **prompt change**, with a small mirroring extension on the Rust side:

**In `GPU_SPLIT_PROMPT` (new, sibling to `UNIVERSAL_SPLIT_PROMPT`)**, prescribe the GPU contract as part of what the AI must emit:

- `device.cu` / `device.hip` is the new 5th file containing all `__global__`/`__device__` code.
- The host module's `HotApi` table gains optional GPU fields (described in the prompt with example C++ that the AI must conform to):
  - `device_descriptor` returning `{vendor, arch[], kernel_symbols[], constant_layout}`
  - `device_on_load(prev_blob, len)` — rebinds buffers/constants after `cuModuleLoad`; this is where the AI natively patches deserialization across an ABI change, no migration shim required
  - `device_save_size` / `device_save_write` — size-then-write msgpack, mirrors the existing host v2 pattern (`PLUGIN_ABI.md:608-613`)
  - `device_kernel_sig_hash(name)` — SipHash-2-4 over kernel params
- Hard rules go in the prompt the same way "MALLOC PROHIBITION" goes in `UNIVERSAL_SPLIT_PROMPT` today (`prompts.py:2925`): no `cuMalloc` outside the registered shim; no destruction of the CUDA/HIP context inside `device_on_unload`; constants accessed via `cuModuleGetGlobal` only.

Compatibility tiers (used by the worker's reload classifier, with the same shape as today's host story):

- All `kernel_sig_hash` unchanged → fast device swap (`cuModuleUnload` + `cuModuleLoadData`, keep all buffers).
- New kernel added, old hashes unchanged → swap + extend launch graph.
- Any kernel signature changed / `__constant__` layout changed → cold device reload, state migrated through `device_on_load`.
- Vendor or arch incompatible → fall through to existing process restart.

**On the Rust side**, the only changes are mechanical:

- `runtime/plugin_contract.rs` — append the GPU function-pointer fields to the `HotApi` struct (after the existing optional fields, with `struct_size`-based forward compat, exactly the way v2.1 added `semantic_hash` per the file's own comment at line 12-19). Old modules without the fields stay valid because they have a smaller `struct_size`.
- `runtime/runner/validator.rs` — add presence checks for the new exports when the project's manifest has `gpu` set.
- `runtime/capability.rs` — add bool flags mirroring the existing `core_on_load`/`gui_on_load` pattern.

`PLUGIN_ABI.md` gets a short documentation appendix describing the new fields, but the spec for what the AI emits lives in `GPU_SPLIT_PROMPT`.

### 5.3 Worker — compiler dispatch and device adapter

**Compiler dispatch.** Today `compile_core.rs:41` already reads `effective_manifest.compiler.executable()` — the hardcoding lives in the *enum*, not the call site. Add a small helper on `CompileManifest`:

```rust
// in compile_manifest.rs
pub enum ModuleKind { Core, Gui, Shared, HostRunner, Device }

impl CompileManifest {
    pub fn select_compiler(&self, kind: ModuleKind) -> &'static str {
        match kind {
            ModuleKind::Device => self.gpu.as_ref()
                .map(|g| g.device_compiler.executable())
                .unwrap_or("nvcc"),
            _ => self.compiler.executable(),
        }
    }
}
```

Update `compile_helpers.rs::is_cpp_compiler` (line 299) so `nvcc`/`clang-cuda`/`hipcc` are *not* wrapped by ccache (the device-compile cache lives in a separate stage — ccache doesn't understand cubin/hsaco hashing).

**New stage `compile_device.rs`** under `worker/src/compiler/stages/` modelled on `compile_runner.rs`:

- Writes `device.cu` (CUDA) or `device.hip` (HIP) into the workspace.
- Invokes `nvcc -arch=<sm_xx> -ptx -o device_<ts>.ptx` followed by `nvcc --cubin` (CUDA) or `hipcc --genco -o device_<ts>.hsaco` (ROCm). Cache key: `IncrementalCache::cache_key(device_src, device_flags, [arch_list])` — same pattern as `compile_core.rs:75`.
- Streams stderr through `ptxas_info_parser.rs` (§11) and attaches a `GpuToolchainDiagnostics` to the compile result.
- Returns `Option<PathBuf>` for the cubin/hsaco; `None` when no device module.

**New adapter `gpu_module_adapter.rs`** under `worker/src/hmr/` implementing the existing `Adapter` trait (`adapter_trait.rs`). It owns the CUDA/HIP context for the lifetime of the project (separate from per-cubin module handles), opens the cubin via `cuModuleLoadData` / `hipModuleLoad`, and resolves kernel handles via `cuModuleGetFunction` / `hipModuleGetFunction`. On unload it calls `cuModuleUnload` / `hipModuleUnload` — never destroys the context (that's where the buffers live).

Register two new languages in `adapter_registry.rs:19-53` and rows in `adapter_matrix.rs:107-181`:

```rust
"cuda" | "rocm" => Some(Box::new(GpuModuleAdapter::new(GpuConfig {
    vendor: if language == "cuda" { Vendor::Cuda } else { Vendor::Rocm },
    ..Default::default()
})))
```

Note: these adapters are **paired**, not standalone — a GPU project always has a host adapter (`cpp`) for the main 4 modules and a `cuda`/`rocm` adapter for the device module. The `Slot` enum in `slot_manager.rs` adds a `Device` variant.

**State snapshot extension.** Add a sibling type in `state_snapshot.rs` (after line 41):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStateSnapshot {
    pub vendor: DeviceVendor,
    pub driver_blob: Option<Vec<u8>>,         // tier A
    pub buffers: Vec<DeviceBufferRecord>,     // tier B
    pub constant_mem: Vec<ConstantSlotRecord>,
    pub stream_topology: Vec<StreamRecord>,
    pub kernel_sig_hashes: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshotV2 {
    pub host: StateSnapshot,
    pub device: Option<DeviceStateSnapshot>,
}
```

Keep `StateSnapshot` untouched so existing host-only paths and tests don't move; the new `StateSnapshotV2` envelope is what the GPU reload orchestrator passes around.

### 5.4 Reload orchestration

The actual reload state machine the user runs lives in `runtime/loader.rs` + `runtime/hot_reload/v2.rs` + `compiler/handler.rs` (the `dynlib_reload.rs` file is a diagnostic stub with hardcoded `duration_ms` values — do not extend it). Add device-aware orchestration as a new `gpu_reload_orchestrator.rs` that wraps the existing host swap path:

```text
match reload_plan {
  host_only    => existing host swap
  device_only  => device_swap()
  mixed        => device_save() ; host_swap() ; device_swap() ; device_restore()
  abi_breaking => cold reload + device_on_load on new context
}

device_swap():
  1. drain  — synchronize tracked streams (or cuCheckpointProcessLock if tier A)
  2. save   — device_save_write OR cuCheckpointProcessCheckpoint (tier A)
  3. unload — cuModuleUnload / hipModuleUnload  (context kept alive)
  4. load   — cuModuleLoadData / hipModuleLoad  on new cubin/hsaco
  5. restore— cuCheckpointProcessRestore (tier A) OR replay buffers + constants
              + stream topology (tier B), then call device_on_load
  6. verify — device_kernel_sig_hash for each expected kernel; mismatch → rollback
```

Rollback symmetry: keep the previous cubin alongside the new one in a small device-side slot pool, mirroring the host slot pool already in `slot_manager.rs`.

### 5.5 AI engine — three new endpoints

Add in `ai-backend/ai-engine/main.py` next to the existing `/refactor/*` family. They all reuse `ask_llm` (`llm/providers/base.py:19`), the architecture cache extractor (`main.py:103-112`), and the verifier scaffolding.

| Endpoint                          | Trigger                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `POST /refactor/split/gpu`        | First compile when `gpu_detect.py` flags GPU. Branched from `main.py:1527`.       |
| `POST /refactor/diff_patch/gpu`   | Edits touching `device.cu`/`device.hip` or any `<<<…>>>` launch site. Branched from `main.py:1919`. |
| `POST /refactor/heal/gpu`         | nvcc/hipcc/ptxas errors, threshold-breaching ptxas warnings, or runtime faults. Branched from `main.py:2031`. Dispatch to tier-specific sub-prompts inside the agent (§11). |

New prompt templates live next to `UNIVERSAL_SPLIT_PROMPT` (`ai-backend/ai-engine/llm/prompts.py:2872`):

- `GPU_SPLIT_PROMPT` — produces the existing 4 files plus `device.cu`, plus an explicit launch-graph block inside `<synthi_arch_cache>`, plus the `gpu` sub-block inside `<synthi_build_manifest>`.
- `GPU_DIFF_PATCH_PROMPT` — same `{module, operation, anchor, content}` schema as today (`diff_patch_helpers.py:94-96`), with `"device"` added to `VALID_EDIT_MODULES`, plus a top-level `reload_plan` field consumed by the worker.
- `GPU_HEAL_COMPILE_PROMPT`, `GPU_HEAL_PERF_PROMPT`, `GPU_HEAL_RUNTIME_PROMPT` — three siblings modeled on `format_heal_prompt` (`llm/structural_prompts.py:82`), each one aware of the toolchain dialect relevant to its tier. See §11 for tier semantics.

### 5.6 Agent contracts (Python side)

Each agent has a strict pydantic input/output schema; no free-form text crosses agent boundaries. Reuse `verifier.py:256` for shape validation and add `verifier_gpu.py` for GPU-specific checks (every `<<<…>>>` launch in host code has a matching `__global__` symbol in `device.cu`; declared `arch` matches what the kernel actually uses; healer outputs contain no shim/wrapper kernels — see §11.4).

1. **`gpu_detect.py`** (no LLM). Regex over the project's source files: presence of `__global__`, `__device__`, `<<<…>>>` syntax, `cudaMalloc`/`hipMalloc`, `#include <cuda_runtime.h>` / `<hip/hip_runtime.h>`. Tree-sitter is *optional* (the codebase already uses it lazily in `shadow/runner/syntax.py:44-58`); regex must be the primary path so no new install dependency lands on workers. Returns `{is_gpu: bool, vendor_hint: "cuda"|"rocm"|"ambiguous"}`.

2. **Kernel Splitter Agent** (`agents/kernel_splitter.py`). One `ask_llm` call with `GPU_SPLIT_PROMPT`. Validates with `verifier.py` for the shape and `verifier_gpu.py` for the GPU rules. Output: existing `<JSON>` block extended to 5 files + arch cache + manifest with `gpu` block.

3. **Launch-Graph Extractor** (`agents/launch_graph_extractor.py`). Hybrid: a regex pass over `<<<grid, block, shared, stream>>>` for the static cases; one small LLM call for the symbolic cases. The launch graph is stored *inside* the arch cache so subsequent agents have one source of truth.

4. **ABI Stamper** (`agents/abi_stamper.py`, no LLM). Computes per-kernel SipHash-2-4 over the parameter list, plus `constant_layout_hash`. Writes them to `.synthi_split_meta.json` next to the existing host hashes the worker already persists. Worker compares on every reload to decide fast-swap vs cold-reload.

5. **GPU Mod-Delta Classifier** (`agents/gpu_mod_delta.py`, no LLM). Diffs the edit by file:
   - changes only inside `device.cu` and don't touch any exported kernel signature → `device_only`
   - changes only in host modules → `host_only` (route to the existing `/refactor/diff_patch`)
   - any kernel signature changed → `abi_breaking`
   - both sides changed → `mixed`

   Saves an LLM call on the easy cases, which are the majority.

6. **GPU Mod-Delta Patcher** (same module). LLM via `GPU_DIFF_PATCH_PROMPT`. Reuses the existing anchor-based edit schema from `diff_patch_helpers.py`; adds `"device"` to `VALID_EDIT_MODULES` and a top-level `reload_plan` enum.

7. **GPU Error Triage** (`agents/gpu_error_triage.py`, no LLM). Mechanical classifier — input is a `GpuToolchainDiagnostics` record and/or a `gpu_runtime_error` event; output is a tier label (`compile_hard` / `compile_soft` / `runtime`) plus the chosen sub-prompt. See §11.1.

8. **GPU Healer Agent** (`agents/gpu_healer.py`). Single agent dispatching to one of `GPU_HEAL_COMPILE_PROMPT` / `GPU_HEAL_PERF_PROMPT` / `GPU_HEAL_RUNTIME_PROMPT` based on the triage result. Same `{module, operation, anchor, content}` edit schema as the existing host healer. Verifier rejects any output that creates a new file or a name-similar wrapper kernel (§11.4).

## 5.7 Runtime guardrails

Three explicit guardrails the orchestrator must enforce — without them the GPU loop can lock up the user's workspace.

**Drain timeout (Phase 3, `gpu_reload_orchestrator.rs::device_swap` step 1).** `cuStreamSynchronize` blocks until the kernel completes. A user infinite loop or device-side deadlock would block the worker thread forever. Wrap the drain in a 2000 ms timeout (configurable via `SYNTHI_GPU_DRAIN_TIMEOUT_MS`); on timeout, abort the snapshot, log the hang, fall through to a process kill + cold restart on the next compile, and surface a "kernel hang detected" error card to the frontend. Same pattern as the existing host compile timeout in `compile_core.rs:11` (`tokio::time::timeout`).

**Heal retry cap (Phase 3, GPU Healer Agent).** The healer can spin in a loop of failed compiles if the model misunderstands the toolchain error. Hardcode `MAX_HEAL_RETRIES = 2` in the orchestrator that calls `/refactor/heal/gpu`. After 3 total compile attempts (initial + 2 heal retries), bail out and surface the raw nvcc/hipcc/ptxas error to the user via the existing `CompileErrorCard.jsx` flow. Mirror exactly how the existing host healer is bounded (verify the same cap exists in the host path; if not, add it there at the same time — same risk applies).

**GPU mode UI toggle.** Add a button next to the existing HMR toggle at `synthi/src/app/workspace/TopNav.jsx:168` ("HMR" / "No HMR") with the same visual treatment ("GPU" / "No GPU"). When enabled, the frontend sends `prefer_gpu_pipeline: true` on compile requests; when disabled, the GPU detector still runs but routes everything through the host-only pipeline (treats kernels as plain C++ that fails to compile — useful for debugging and for users on machines without a GPU runtime). Backend wiring: a new optional `gpu_mode` field on the compile request, defaulting to `auto` (detector-driven). Persist the toggle state in Redux next to the existing HMR state — find that location via the `useHMR` hook (`synthi/src/hooks/useHMR.js`).

## 6. Two-tier device-state snapshot

This is the user's "binary device snapshot" requirement. Decided per-workspace at probe time, identical envelope to the rest of the worker.

**Tier A — driver checkpoint (preferred).** At workspace start, `device_checkpoint_probe.rs` resolves `cuCheckpointProcessLock` from `libcuda.so` (CUDA ≥ 12.5 / driver ≥ 555) and probes for `criu-amdgpu` (ROCm). When available, the snapshot path is one driver call: lock the process, checkpoint into `DeviceStateSnapshot.driver_blob`. Restore is one call. True binary snapshot — fastest, captures streams/events/in-flight work natively.

**Tier B — userspace serializer (always available).** Required because the driver feature is recent and not on every machine.

1. **Buffer registry.** A 50-line shim in `host_runner.cpp` wraps `cudaMalloc`/`hipMalloc` and records `(ptr, size, owner_module, semantic_name)` for every live device allocation. The runner template already exists (it's what the AI synthesises today); the shim is a small addition.
2. **Drain.** `cuStreamSynchronize` every known stream; record the stream/event DAG before draining so it can be reconstructed.
3. **Pack.** `cuMemcpyDtoH` every registered buffer into a single pinned-host arena; copy `__constant__` symbols via `cuModuleGetGlobal` + `cuMemcpyDtoH`. Serialize with **msgpack** (matches the host v2 path — `PLUGIN_ABI.md:608-613` — so the wire framing is uniform).
4. **Restore.** Context is alive across the swap; reallocate buffers with the same sizes, `cuMemcpyHtoD` from the arena, restore constants, recreate streams + events with the recorded topology. `device_on_load` lets user code rebind any pointers it stashed — and, critically, lets the AI *natively patch the deserialization logic itself* when the struct layout changes across an ABI edit, so no migration shim is ever needed.

Both tiers expose the same `DeviceStateSnapshot` Rust type to the rest of the worker; only the `driver_blob`-vs-`buffers` arm differs. The agent pipeline is unaware of which tier is in use; `gpu.snapshot_mode = "auto"` lets the worker pick.

## 7. Phased rollout

Feature-flagged on `SYNTHI_GPU_HMR=1` so non-GPU projects stay completely untouched during the rollout.

**Phase 0 — Foundations (~1 week).** GPU Project Detector. `BuildManifest.gpu` block (Python + Rust). `compile_device.rs` produces a hello-world cubin and the host runner launches it. No HMR yet — proves the toolchain works end-to-end.

**Phase 1 — Cold-reload CUDA (~1 week).** Kernel Splitter Agent + `GPU_SPLIT_PROMPT`. v2.1 ABI exports on the host `HotApi`. `gpu_module_adapter.rs` wired with `cuModuleLoadData`/`cuModuleUnload`. Userspace tier-B snapshot only; on every edit, full cold device reload. Demo: a CUDA reduction kernel keeps its input buffer across an edit that only changes the kernel body.

**Phase 2 — Fast device-only swap + ROCm parity (~1.5 weeks).** ABI Stamper + GPU Mod-Delta Classifier + GPU Mod-Delta Patcher. `reload_plan` consumed by the worker; `device_only` runs the fast path. Mirror the adapter for ROCm via `hipModuleLoad`. Demo: edit kernel body → kernel swapped in <300ms, buffers untouched. Same demo on AMD.

**Phase 3 — Mixed + driver checkpoint + healer (~1.5 weeks).** Mixed reload orchestration (`device_save → host_swap → device_swap → device_restore`). Tier-A driver checkpoint + auto-detect. Three-tier GPU Healer (§11) — compile hard, compile soft (ptxas warnings), runtime fault. Stream-deadlock watchdog. Demo: edit host launch site *and* kernel body together; project resumes with streams + in-flight work intact (where driver supports it). Demo: induce an illegal-address kernel, click the heal card, AI patches the bounds check natively, project resumes.

**Phase 4 — Polish (~0.5 week).** Frontend surfaces `reload_plan` + snapshot tier + ptxas info badges. Bench fixtures (vector add, reduction, gemm) under `ai-backend/ai-engine/bench/corpus/gpu/` plug into the existing `bench/harness.py`. CI gate: block PRs to `cuda-hmr` if device-swap latency regresses >5% or any state-survival assertion fails.

**Phase 5 — Cross-TU device linking (`-rdc=true`) (~2 weeks, separate milestone).** Phases 0-4 ship a single monolithic `device.cu` (or `device.hip`). Phase 5 adds support for projects that split GPU code across multiple translation units — what real game engines and physics simulations need.

Concretely:

1. **Kernel Splitter** is upgraded so `GPU_SPLIT_PROMPT` can emit multiple device files (e.g. `device_math.cu`, `device_core.cu`, `device_utils.h`) instead of one. Manifest gains `gpu.rdc: bool` and `gpu.device_units: List[str]`.
2. **`compile_device.rs`** branches on `gpu.rdc`:
   - `false` (Phases 0-4 default): single `nvcc --cubin` invocation.
   - `true`: two-step build — `nvcc -dc <file>.cu -o <file>.o` per TU (with per-TU `IncrementalCache` keys so unchanged TUs hit), then `nvcc -dlink` (or `hipcc --hip-link`) to stitch the device `.o`s into the final cubin/hsaco.
3. **GPU Mod-Delta Patcher** narrows edits to the dirty TU. The worker re-runs step 1 only for the changed `.cu`, reuses cached `.o`s for the rest, then re-runs step 2 to relink. The hot-swap on the resulting cubin still uses `cuModuleLoadData` exactly as in Phases 1-2.
4. **ABI Stamper** is extended to track cross-TU dependencies. A change to a header file or a shared `__device__` signature triggers recompilation of every TU that includes/calls it; the dependency map lives in `.synthi_split_meta.json` next to the existing per-kernel hashes.
5. The ROCm equivalent (`hipcc --gpu-rdc` + `hipcc --hip-link`) lands in the same phase.

Keeping this as a dedicated phase isolates the compile-orchestration complexity from the state-snapshot and reload-classifier work in Phases 1-3, and protects the Phase 2 device-swap demo from being blocked by a device-linker regression. Until Phase 5 lands, the Mod-Delta Classifier detects `-rdc` in the manifest and forces cold reload (already noted in §10).

## 8. Critical files

**Edit:**
- `synthi/src/app/workspace/TopNav.jsx:168` — add "GPU" / "No GPU" toggle button next to the existing "HMR" / "No HMR" toggle, same visual treatment. Wire to a new `gpuMode` Redux slice; the value rides on compile requests as `prefer_gpu_pipeline`.
- `synthi/src/hooks/useHMR.js` — add a sibling `useGpuMode` hook (or extend the existing one) so other panels can read the toggle state.
- `ai-backend/ai-engine/build_manifest.py:55-105` — add `GpuBuildBlock`, `DeviceCompiler`, `DeviceVendor`, `SnapshotMode` literals; add optional `gpu` field to `BuildManifest`. Extend `validate_manifest_v1` to enforce `fatbin_strategy == "sidecar_module"`.
- `ai-backend/ai-engine/main.py:1527` — branch into Kernel Splitter when `gpu_detect` flags GPU.
- `ai-backend/ai-engine/main.py:1919` — branch into GPU Mod-Delta Patcher when classifier returns non-`host_only`.
- `ai-backend/ai-engine/main.py:2031` — branch into GPU Healer for nvcc/hipcc/ptxas/runtime error payloads.
- `ai-backend/ai-engine/llm/prompts.py` — add `GPU_SPLIT_PROMPT`, `GPU_DIFF_PATCH_PROMPT`, `GPU_HEAL_COMPILE_PROMPT`, `GPU_HEAL_PERF_PROMPT`, `GPU_HEAL_RUNTIME_PROMPT` next to `UNIVERSAL_SPLIT_PROMPT` (line 2872).
- `ai-backend/ai-engine/diff_patch_helpers.py:96` — add `"device"` to `VALID_EDIT_MODULES` (gated on the request being from the GPU pipeline so host-only requests still reject device edits).
- `backend/synthi-webrtc-compiler/PLUGIN_ABI.md:567+` — short documentation appendix describing the new GPU `HotApi` fields (the canonical contract lives in `GPU_SPLIT_PROMPT`, not here).
- `backend/synthi-webrtc-compiler/worker/src/runtime/plugin_contract.rs` — append GPU function-pointer fields to `HotApi`, gated by `struct_size` so older modules without them stay valid (same forward-compat pattern v2.1 used for `semantic_hash` per the file's own header at line 12-19).
- `backend/synthi-webrtc-compiler/worker/src/runtime/runner/validator.rs:17-53` — add presence checks for the GPU exports when manifest has `gpu`.
- `backend/synthi-webrtc-compiler/worker/src/runtime/capability.rs:91-168` — add bool flags mirroring `core_on_load`/`gui_on_load`.
- `backend/synthi-webrtc-compiler/worker/src/hmr/compile_manifest.rs:114-180` — add `DeviceCompiler` enum, `GpuBuildBlock`, optional `gpu` field on `CompileManifest`, `select_compiler()` and `ModuleKind`.
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_helpers.rs:299` — extend `is_cpp_compiler` so `nvcc`/`clang-cuda`/`hipcc` are NOT ccache-wrapped.
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_core.rs:41` and `compile_gui.rs` — call `manifest.select_compiler(ModuleKind::Core/Gui)` instead of `manifest.compiler.executable()`.
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_registry.rs:19-53` — add `"cuda"`, `"rocm"` cases.
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_matrix.rs:107-181` — add device-adapter rows.
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_snapshot.rs:41` — append `DeviceStateSnapshot` + `StateSnapshotV2` envelope.
- `backend/synthi-webrtc-compiler/worker/src/hmr/slot_manager.rs` — add `LibSlot::Device` variant and per-vendor slot pool.
- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs:1171+` — schedule `compile_device` alongside `compile_core`/`compile_gui`/`compile_runner` when manifest has `gpu`.

**Create:**
- `ai-backend/ai-engine/agents/gpu_detect.py`
- `ai-backend/ai-engine/agents/kernel_splitter.py`
- `ai-backend/ai-engine/agents/launch_graph_extractor.py`
- `ai-backend/ai-engine/agents/abi_stamper.py`
- `ai-backend/ai-engine/agents/gpu_mod_delta.py` (classifier + patcher)
- `ai-backend/ai-engine/agents/gpu_error_triage.py` (no LLM; classifies diagnostics + runtime events into heal tiers)
- `ai-backend/ai-engine/agents/gpu_healer.py` (dispatches to the three tier-specific sub-prompts)
- `ai-backend/ai-engine/verifier_gpu.py`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_device.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/ptxas_info_parser.rs` (parses ptxas info/warning lines into structured records)
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_module_adapter.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/device_snapshot.rs` (tier A + tier B)
- `backend/synthi-webrtc-compiler/worker/src/hmr/device_checkpoint_probe.rs` (driver feature detection)
- `backend/synthi-webrtc-compiler/worker/src/hmr/gpu_reload_orchestrator.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/gpu_runtime_watchdog.rs` (stream-completion watchdog; synthesizes `STREAM_HANG` events)

**Reuse (no edits):**
- `ai-backend/ai-engine/llm/providers/base.py:19` — `AiProvider.ask_llm`.
- `ai-backend/ai-engine/diff_patch_helpers.py:53,99` — `DiffPatchRequest` schema and `validate_edit_list` (extend `VALID_EDIT_MODULES`, don't rewrite).
- `ai-backend/ai-engine/main.py:103-217` — `<synthi_arch_cache>` / `<synthi_build_manifest>` extractor.
- `ai-backend/ai-engine/analyzer/proactive/cache.py:35` — `AnalysisCache` for caching GPU detection + driver probes.
- `ai-backend/ai-engine/verifier.py:256` — `AIOutputVerifier`.
- `backend/synthi-webrtc-compiler/worker/src/runtime/loader.rs:98` — `libloading::Library::new(path)` for the host swap path.
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_helpers.rs:188,227` — `compile_to_object_command`, `link_object_to_so_command` (host modules unchanged).

**Branch.** No `cuda-hmr` branch exists yet — start work with `git checkout -b cuda-hmr` from `main`.

## 9. Verification — in-depth testing playbook

This section is the operator manual for verifying each phase. It is **deliberately concrete**: exact files, exact commands, exact JSON shapes, exact pixel/log expectations. The automation harness in §12 implements the green path described here; this section also covers the manual flow you run when the harness is itself under development.

### 9.0 Prerequisites

**Host machine (worker side).**

- NVIDIA: driver ≥ 535 (Tier-A driver checkpoint needs ≥ 555 / CUDA 12.5). Verify: `nvidia-smi`, `nvcc --version` ≥ 12.0.
- AMD (ROCm): driver ≥ 6.0. Verify: `rocminfo`, `hipcc --version`. For CI without an AMD GPU, fall back to the HIP-CPU runtime.
- ccache present but **not** in PATH for the device compile stage (§5.3) — verify with `ccache -s` before and after a device compile; counters must not increment.
- Sufficient device memory: each fixture below sizes buffers to fit in ≤ 64 MiB so a 4 GiB device is enough.

**Backend services (host).** All services from `live-test.mjs` preamble must be up. Concretely:

```
docker compose ps                       # signaling, collab, redis, y-sweet, ai-engine, gateway, frontend, worker
curl -s localhost:3000/api/ready        # frontend
curl -s localhost:1234/health           # collab
nc -z localhost 9000                    # signaling
```

The worker must be built with the `gpu-hmr` cargo feature: `cargo build --features gpu-hmr -p synthi-webrtc-compiler`. The feature gates the new adapter; without it the GPU manifest field is ignored and tests fall through to the host-only path — which is itself a useful negative test (see §9.6).

**Feature flag.** Every test session exports `SYNTHI_GPU_HMR=1` so the orchestration changes are live. Without it the worker silently routes through the legacy host-only path.

**Frontend toggle.** The "GPU" / "No GPU" toggle from §5.7 is wired to Redux. Tests that exercise the *enabled* path send `prefer_gpu_pipeline: true` on compile requests; tests that exercise the *disabled* path send `false` and assert the project compiles as plain C++ (or fails predictably).

### 9.1 Workspace seeding intricacies

Seeding a GPU workspace uses the same wire as `live-test.mjs` (Phase 2-3 of that script) plus three deltas:

1. The seed file set is **5 files**, not 1: `shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`, `device.cu` (or `device.hip`). The Kernel Splitter Agent normally produces this set on first compile, but in the test harness we seed the post-split layout directly so we can assert against known SipHash-2-4 kernel signatures.
2. The `BuildManifest` includes a `gpu` block (§5.1). We seed it as `.synthi/build_manifest.json` in the workspace alongside the source files; the worker reads it on first compile so the device pipeline kicks in immediately without waiting on the LLM.
3. Initial compile is **worker-driven**, not browser-driven. Unlike `live-test.mjs` Phase 2 (which waits for the browser to mount the workspace), the GPU harness sends `synthi_compile` with `prefer_gpu_pipeline:true` directly. The frontend is only needed if you want to interactively inspect the running app.

Seed pattern (mirrors `writeFilesBatchCollab` in `live-test.mjs:140-155`):

```js
await writeFilesBatchCollab({ collabUrl, slug, userId, syncToGcs: true, files: [
  { path: 'shared.h',         content: SHARED_H },
  { path: 'core.cpp',         content: CORE_CPP },
  { path: 'gui.cpp',          content: GUI_CPP },
  { path: 'host_runner.cpp',  content: HOST_RUNNER_CPP },
  { path: 'device.cu',        content: DEVICE_CU },
  { path: '.synthi/build_manifest.json', content: JSON.stringify(MANIFEST) },
]});
await stageAndCommit({ collabUrl, slug, userId, message: 'gpu-hmr-test: seed' });
```

`MANIFEST.gpu` for the CUDA path:
```json
{ "vendor": "cuda", "device_compiler": "nvcc", "arch": ["sm_80"],
  "device_flags": ["-O3","-lineinfo","--use_fast_math"],
  "runtime_libs": ["cudart","cuda"],
  "snapshot_mode": "auto",
  "fatbin_strategy": "sidecar_module" }
```

For ROCm, swap `vendor: "rocm"`, `device_compiler: "hipcc"`, `arch: ["gfx90a"]`, `runtime_libs: ["amdhip64"]`.

### 9.2 Test fixtures

Three fixtures live under `mcp/synthi-mcp/tests/fixtures/gpu/`. Each is a complete, hand-written post-split project (no LLM in the loop) so the harness can assert exact behavior.

**`vector_add/`** — Phases 0–2 baseline.
- `device.cu` exports `__global__ void vec_add(const float* a, const float* b, float* c, int n)`.
- `core.cpp` allocates 3 device buffers of `N = 1<<20` floats, fills `a` and `b` with deterministic patterns (`a[i] = i`, `b[i] = 2*i`), launches `vec_add`, copies `c` back, and renders a 256-bin histogram of `c` to the canvas.
- Edit script: replace the `+` in `c[i] = a[i] + b[i];` with `*`. After HMR the histogram visibly shifts from a linear ramp to a sparse cluster.
- Assertions: the `cudaMalloc` pointer for `a` is reused across the swap (worker log line `[gpu-adapter] reused buffer a=0x… size=4194304`). Visual pHash hamming > 4. Kernel signature hash unchanged → `reload_plan = device_only`.

**`reduction/`** — Phase 1 cold-reload + buffer survival.
- `device.cu` exports `__global__ void block_reduce(const float* in, float* partials, int n)`; host completes the reduction on CPU.
- Edit: change the per-block accumulator from sum to max.
- Assertion: the input buffer (≈ 4 MiB) survives the swap; reported reduction value transitions from `Σi` (1 048 575 × 524 288) to `N - 1` exactly on the first post-HMR frame.

**`gemm/`** — Phase 2 fast device swap + Phase 3 mixed.
- `device.cu` exports `__global__ void gemm_naive(const float* A, const float* B, float* C, int M, int N, int K)` with constant-memory `__constant__ float alpha[1]; __constant__ float beta[1];`.
- Edit A (device-only): vectorize the inner loop. `reload_plan = device_only`.
- Edit B (mixed): change `alpha`/`beta` types from `float` to `float2` AND update the host launch site. `reload_plan = mixed`. Constant-memory layout change is treated as ABI-breaking under the §5.7 rules; the harness must observe a *cold* reload (no buffer pointer reuse) with `device_on_load` invoked once.

All three fixtures include a `golden.json` describing:
- expected `reload_plan` per edit step,
- expected `kernel_sig_hashes` before and after,
- expected per-phase post-HMR pixel sample (center pixel of the canvas) with tolerance,
- expected worker log markers (regex per phase).

### 9.3 Phase 0 — toolchain smoke

**Goal.** Prove the worker invokes `nvcc` / `hipcc`, produces a cubin/hsaco, and the host runner can launch one kernel.

**Manual recipe (5 min).**
1. Seed `vector_add/` (§9.2).
2. `POST /compile` with `prefer_gpu_pipeline:true`.
3. Tail `worker.log`, expect within 30 s:
   ```
   [compile-device] nvcc -arch=sm_80 -O3 -lineinfo --use_fast_math -ptx -o device_*.ptx
   [compile-device] nvcc --cubin -o device_*.cubin
   [ptxas] Used 18 registers, 0 bytes spill
   [gpu-adapter] cuModuleLoadData ok  module=…  kernels=[vec_add]
   ```
4. The window shows the linear histogram. No errors in `worker.log`, no `gpu_runtime_error` events.

**Pass/fail.**
- Pass: a `device_*.cubin` is present under `<workspace>/.synthi/build/`. Its mtime > the compile request timestamp.
- Fail: missing cubin, or `nvcc` invoked via ccache (`is_cpp_compiler` regression — §5.3).

**Common failure modes and the fix.**
- `nvcc: command not found` → PATH not set in worker container. `docker exec worker which nvcc` should resolve.
- `unsupported gpu architecture 'sm_80'` → arch mismatch; the harness skips this fixture on hardware older than Ampere and emits a `skipped` row.
- ccache wrapping nvcc → assertion fails on `worker.log` containing `ccache nvcc`. Fix `is_cpp_compiler` (§5.3).

### 9.4 Phase 1 — cold reload with buffer survival

**Goal.** A device-only edit reloads the cubin without restarting the process or destroying buffers.

**Manual recipe.**
1. Run Phase-0 first; leave the window open.
2. Apply the edit (replace `+` with `*` in `device.cu`).
3. `POST /compile`, then `synthi_wait_hmr` (timeout 30 s).
4. Expected `worker.log` markers:
   ```
   [gpu-reload] plan=device_only  reason=device-file-only-edit
   [gpu-reload] step=drain   streams_synced=1  ms=…
   [gpu-reload] step=save    tier=userspace  buffers=3  bytes=12582912
   [gpu-reload] step=unload  module=…
   [gpu-reload] step=load    cubin=device_*.cubin  ms=…
   [gpu-reload] step=restore bufs_replayed=3  bytes=12582912
   [gpu-reload] step=verify  sig_match=1/1  ok
   ```
5. Visual: the histogram shifts. pHash hamming > 4.
6. Buffer survival: log line `[gpu-adapter] reused buffer a=0x7f… size=…` for each of `a`, `b`, `c`. Pointer values from the post-load log must equal the pre-edit pointers (recorded in `before.log`).

**Negative test.** Repeat with `SYNTHI_GPU_HMR=0`. Expect the worker to fall through to cold restart and the buffer pointers to change. The harness asserts the *positive* case logs `reused buffer` ≥ 3 times and the *negative* case logs `cold-restart` once.

### 9.5 Phase 2 — fast device-only swap (and ROCm parity)

**Goal.** Device-only edits take <300 ms wall clock; param-type edits trip `abi_breaking` and cold-reload cleanly.

**Recipe — fast path.**
1. Use `gemm/` fixture, Edit A (vectorize inner loop).
2. Compile, wait HMR.
3. Worker emits `[gpu-reload] plan=device_only` and `total_ms` ≤ 300 (configurable via `SYNTHI_GPU_FAST_SWAP_BUDGET_MS`, default 300).
4. Output matrix `C` (sampled by the host runner and rendered as a 16×16 thumbnail) is numerically unchanged within `1e-4` (vectorization shouldn't move the values).

**Recipe — abi_breaking.**
1. Edit `device.cu` to change `gemm_naive`'s last param from `int K` to `int K, float alpha_scalar`. Do NOT update the host launch site (we want the classifier to detect the signature drift before the host can even compile).
2. Compile. Expect: `[gpu-reload] plan=abi_breaking` and either (a) the heal endpoint fires because the host now has an unresolved symbol, or (b) the verifier rejects the patch as `signature_changed_without_host_update`. Either path is acceptable; assert both don't both fire.

**ROCm parity.** Re-run §9.4 and §9.5 with `vendor:"rocm"` manifest. On CI without an AMD GPU, set `SYNTHI_GPU_HIP_FAKE_RUNTIME=1` to load the HIP-CPU runtime; the assertion list is identical except the `[gpu-adapter]` log prefix says `hip` instead of `cu`.

### 9.6 Phase 3 — mixed reload + driver checkpoint + healer drills

**Goal.** Prove the orchestrator can save → host-swap → device-swap → restore in one pass; prove both snapshot tiers work; prove the three healer tiers patch existing files without emitting shims.

**Mixed recipe.**
1. Use `gemm/` Edit B (constant-memory type change + host launch update in one batch).
2. Compile. Expect: `[gpu-reload] plan=mixed`, step sequence `device_save → host_swap → device_swap → device_restore`, `device_on_load` invoked exactly once, `kernel_sig_hashes` updated, host pointer (Renderer*) unchanged.
3. Pre-flight: start the project, let it run for ≥ 2 s so an accumulator inside `core.cpp` is non-zero; the accumulator must survive the mixed swap.

**Snapshot tier toggle.**
- Run mixed twice: once with `gpu.snapshot_mode:"driver_checkpoint"`, once with `"userspace"`. On a driver < 12.5, the first run must downgrade automatically; assert the log shows `[device-checkpoint-probe] tier=A unavailable; falling back to tier B`.
- Tier-A run logs `cuCheckpointProcessCheckpoint ok blob=… bytes`.
- Tier-B run logs `[device-snapshot] tier=B buffers=3 bytes=…` and serializes via msgpack.

**Healer drill — Tier 1 (compile hard).**
1. Edit `device.cu`: change `__shfl_down_sync(0xFFFFFFFF, x, 16)` to `__shfl_down(0xFFFFFFFF, x, 16)` (drops the `_sync` suffix; nvcc rejects on sm_70+).
2. Compile. Expect: `[compile-device] nvcc error: identifier "__shfl_down" is undefined`.
3. Harness asserts: heal request fires within 5 s, prompt is `GPU_HEAL_COMPILE_PROMPT`, returned edits target `device.cu` only, no new files, the next compile succeeds.

**Healer drill — Tier 2 (compile soft).**
1. Edit kernel to declare `float local[200];` inside `__global__` body so ptxas reports register spills.
2. Compile. `ptxas info` records 96 registers, 24 bytes spill stores.
3. Harness asserts: triage promotes to Tier 2 because spills > 0 AND the kernel is hot in the launch graph; heal request uses `GPU_HEAL_PERF_PROMPT`; the returned diff contains either an `__launch_bounds__` annotation **or** moves `local[]` to `__shared__`. Verifier-rejected outputs (new file, `_safe` wrapper) must be retried, logged, and bounded by `MAX_HEAL_RETRIES=2`.

**Healer drill — Tier 3 (runtime).**
1. Edit kernel index expression from `out[i]` to `out[i + 4]` for a buffer of length `n`; the last thread block over-indexes.
2. Compile + launch. Expect: `cudaErrorIllegalAddress` raised on the stream callback within 100 ms.
3. Harness asserts: triage = Tier 3, heal prompt = `GPU_HEAL_RUNTIME_PROMPT`, the returned diff fixes the bounds check natively (e.g. `if (i + 4 < n) out[i+4] = …` or reverts to `out[i]`), no new files.

**Stream-hang specifically.**
1. Inject a kernel with `while (true)` guarded by a never-true predicate the compiler can't prove false (use `volatile int* p = &x; while (*p == 0) {}`).
2. Compile + launch. The watchdog (§11.6) synthesizes `STREAM_HANG` after `SYNTHI_GPU_LAUNCH_WATCHDOG_MS` (default 5 s).
3. Harness asserts: `gpu_runtime_error` event with `kind: "stream_hang"` reaches the heal endpoint, the AI patches the launch site or kernel (commonly by adding the missing termination condition), and after MAX_HEAL_RETRIES fails the worker falls through to `drain timeout → process kill → cold restart` (§5.7). The harness verifies the drain timeout fires at the configured 2000 ms — measured from log timestamps.

**No-shim verifier assertions (apply to all three tiers).**

```
for edit in heal_response.edits:
    assert edit.module in BuildManifest.files            # rule 1
    if introduces_global(edit):
        assert not name_similar_to_existing(new_symbol)  # rule 2
    if tier in ('compile_soft','runtime'):
        assert all_existing_kernel_sigs_present()        # rule 3
assert no_new_cu_hip_files(heal_response)                # rule 4
```

### 9.7 Bench corpus integration

Add `ai-backend/ai-engine/bench/corpus/gpu/` with `vector_add/`, `reduction/`, `gemm/` directories matching the existing `bench/corpus/<name>` shape (peek at `bench/corpus/py-off-by-one/` for the format — `before/`, `after/`, `prompt.txt`, `expected.json`). Each GPU fixture's `expected.json` declares the post-edit `reload_plan`, kernel-signature hashes, and a numerical assertion on the output. Wire into `bench/harness.py` by adding the directory to its corpus enumeration; no harness code change beyond the directory listing.

### 9.8 What "green" looks like at the end

Running the harness (§12) against a worker built with `gpu-hmr` should print:

```
━━━ GPU HMR test summary ━━━
  Checked N points: G PASS  W WARN  0 FAIL
  Phases: P0 ✓  P1 ✓  P2 ✓ (cuda)  P2 ✓ (rocm)  P3-mixed ✓  P3-heal-T1 ✓  P3-heal-T2 ✓  P3-heal-T3 ✓
```

Anything in `FAIL` blocks merge to `cuda-hmr`. `WARN` is acceptable for capability-gated checks (e.g. Tier-A driver checkpoint on a < 12.5 driver downgrades to Tier B and emits a WARN, not a FAIL). The pass criteria for the harness itself: zero FAIL rows, and at minimum one phase per phase id covered.

## 10. Risks and open issues

- **Driver version skew.** `cuCheckpointProcessCheckpoint` is recent. The userspace fallback is mandatory and must be the default until we know which drivers ship on Cloud Run / user machines.
- **Separate compilation (`-rdc=true`).** Cross-TU `__device__` calls complicate the single-cubin sidecar model. Phases 0-4 assume whole-program device compilation; the Mod-Delta Classifier detects `-rdc` and forces cold reload until Phase 5 lands proper multi-TU device-link support (see §7 Phase 5).
- **Constant memory layout drift.** Adding a `__constant__` symbol changes layout; treat it as ABI-breaking for now. A future ABI Stamper pass could lay out constants by name-hash to make insertions non-breaking.
- **ROCm CRIU maturity.** `criu-amdgpu` is less battle-tested than CUDA's checkpoint API; expect to lean on tier B for ROCm in practice.
- **Texture/surface references.** Out of scope for v1 (compute-only per the user's scoping). Reserve slots in the launch graph schema for v2.
- **In-flight work semantics under tier B.** When the driver checkpoint is unavailable we drain everything before snapshotting — observable to user code (a kernel that depended on a still-launching one will see it complete sooner). Not a correctness issue, but worth surfacing in the verify panel so users know.
- **Healer convergence on register pressure.** The Tier-2 perf healer can reach a local minimum (e.g. spills traded for shared-memory bank conflicts). The retry cap bounds blast radius, but we should track Tier-2 heal success rate in telemetry — if it sits below ~60% we'll need a richer hardware-spec context in the prompt rather than more retries.

## 11. GPU error feedback loop — fully agentic, no shims

The existing host healer (`/refactor/heal`, `main.py:2031`) consumes compiler stderr and patches files in place. For GPU we keep that exact shape — `{module, operation, anchor, content}` edits to existing files, never new "wrapper" or "fixup" modules — but the error surface is wider in three ways: there are soft compiler warnings that predict runtime failure, true runtime errors caught only after launch, and silent stream hangs that never produce an error code at all. The healer needs all three channels feeding the same agent, behind a single endpoint, with a mechanical verifier that rejects any output that smells like a shim.

### 11.1 Three error tiers

Same heal endpoint (`/refactor/heal/gpu`), three classifier branches. Each maps to one of three prompt variants. The patch shape is identical to today's host healer — edits to existing files, no new files, no wrapper modules.

**Tier 1 — Hard compile failure.** `nvcc`/`hipcc` returns non-zero. Captured by the existing worker stderr pipe in `compile_device.rs` (§5.3). Routed to `GPU_HEAL_COMPILE_PROMPT`. Examples: missing header, type mismatch in kernel param, unsupported intrinsic for the declared `arch`, `nvlink` undefined reference, `-rdc` mismatch, HIP-vs-CUDA divergences (`__shfl_sync` vs `__shfl`, wave size 32 vs 64).

**Tier 2 — Soft compile warning (predictive failure).** `nvcc` exits 0 but ptxas warned about register pressure, spill stores, or constant/shared memory exhaustion. The host *will* be able to launch the kernel, but it will either silently degrade (spills → 10× slowdown) or fail at runtime (`cudaErrorLaunchOutOfResources`). Routed to `GPU_HEAL_PERF_PROMPT`. The AI's job is to natively edit the kernel — add `__launch_bounds__`, split a large kernel into two `__global__`s used by the existing launch graph, move local arrays into shared memory, change register-hungry types — never to add a wrapper.

**Tier 3 — Runtime fault.** The kernel launched but the device or runtime API returned an error. Examples: `cudaErrorIllegalAddress`, `cudaErrorMisalignedAddress`, `cudaErrorLaunchTimeout`, `cudaErrorInvalidConfiguration`, or the synthetic `STREAM_HANG` from the watchdog. Routed to `GPU_HEAL_RUNTIME_PROMPT`. The AI patches the kernel and/or host launch site directly — fixing a bounds check, fixing a divergent stream wait, fixing a missing sync — never adding a "safe-mode wrapper".

### 11.2 Capture surface

**Compile-time (Tier 1 + 2):** `compile_device.rs` already shells out to nvcc/hipcc. Parse stderr with `ptxas_info_parser.rs` (new file, sibling of `compile_helpers.rs`):

```text
ptxas info    : Used 96 registers, 24 bytes spill stores  →  RegisterPressureRecord
ptxas info    : ... 360 bytes cmem[0]                     →  ConstantMemUsageRecord
ptxas warning : 'kernel_foo' uses too much shared data    →  SharedMemWarningRecord
nvlink error  : Undefined reference to '_Z3fooi'          →  LinkErrorRecord
```

Records go into a `GpuToolchainDiagnostics` struct attached to the compile result. The triage agent promotes a record to a Tier-2 heal trigger only when it crosses a threshold derived from the declared `arch` and the project's launch graph (extracted in §5.6 by `launch_graph_extractor.py`):

- registers per thread > 75% of arch's max for the launch's block size → trigger
- spill stores > 0 in any kernel hot in the launch graph → trigger
- constant memory total > 90% of 64 KB → trigger
- shared memory per block > declared launch's static shared bound → trigger

Below threshold, the record is *kept* and shipped to the IDE as an advisory badge — no LLM call, no heal — so users can see "kernel_foo: 84 registers, 12 B spill" in the verify panel without paying for it.

**Runtime (Tier 3):** new instrumentation in the host runner template that the AI synthesizes per `GPU_SPLIT_PROMPT`. Three sources, one channel:

1. `cudaStreamAddCallback` (or `hipStreamAddCallback`) registered on every tracked stream at launch — fires whenever the stream completes with a non-zero status. Carries the most recent kernel symbol launched on that stream.
2. A `cudaPeekAtLastError()` poll right after every `<<<…>>>` site (cheap, sticky). Catches launch-config errors that don't propagate via the stream.
3. `gpu_runtime_watchdog.rs` thread monitors stream completion latency; if any tracked launch hasn't completed in `SYNTHI_GPU_LAUNCH_WATCHDOG_MS` (default 5000), it synthesizes a `STREAM_HANG` pseudo-error with the stream topology snapshot already captured for tier-B snapshots (§6). This is what catches silent stream deadlocks that never produce an error code.

The runner writes records to the same RPC channel the worker uses for HMR events, as a new `gpu_runtime_error` event. The IDE renders a heal card and POSTs to `/refactor/heal/gpu`. No auto-heal by default — the user clicks to trigger, same UX as the existing `CompileErrorCard.jsx` flow. An opt-in setting `synthi.gpu.autoHealRuntime: true` flips it to automatic for users who want the full agentic loop.

### 11.3 What the healer receives

Every heal call gets the same payload shape, regardless of tier — single endpoint, single prompt family. The triage picks the sub-prompt, but the wire schema is uniform:

```json
{
  "tier": "compile_hard" | "compile_soft" | "runtime",
  "error": { "kind": "...", "raw": "...", "parsed": {...} },
  "module_hint": "device.cu" | "core.cpp" | ...,
  "arch_cache": "<full <synthi_arch_cache> contents>",
  "launch_graph": [...],
  "manifest_gpu": { "vendor": "cuda", "arch": ["sm_80"], ... },
  "kernel_sig_hashes": { "kernel_foo": "0x..." },
  "previous_heal_attempts": [ { "tier": ..., "edits": [...], "outcome": "..." } ]
}
```

The architectural overview is critical — it's how the AI knows that `kernel_foo` is a fluid-simulation reduction and reorganizes accordingly instead of guessing. The launch graph tells the AI which block size the kernel actually runs at so it picks the right `__launch_bounds__` and the right shared-memory budget. `previous_heal_attempts` is what makes retries productive — the AI sees what it tried last time and the resulting error or verifier rejection, so it doesn't loop on the same wrong fix.

### 11.4 What the healer is allowed to emit (the no-shim contract)

Same edit schema as `diff_patch_helpers.py:94-96` — `{module, operation, anchor, content}`. The verifier (`verifier_gpu.py`) enforces hard, mechanical rules so "agentic" can never quietly degenerate into "shim-emitting":

- **No file creation.** Only modules listed in the current project's `BuildManifest.files` may be edited. Verifier rejects any edit whose `module` isn't in the existing file set.
- **No wrapper kernels.** Detected by name-similarity heuristic: any newly declared `__global__` symbol whose name is a Levenshtein-near or suffix-extended form of an existing kernel (`kernel_foo_safe`, `kernel_foo_v2`, `kernel_foo_fallback`, `safe_kernel_foo`) is rejected. The rejection message goes back into `previous_heal_attempts` on retry so the next call sees "previous attempt rejected: introduced shim kernel `kernel_foo_safe`".
- **Signature preservation on Tier 2/3.** For edits to `device.cu` in Tier 2 or 3, every existing kernel symbol must still exist with the same name and signature unless the diff includes a matching update to the host launch site. The healer is allowed to *change kernel internals* freely — that's the whole point — but it can't drop a kernel and leave the host calling a ghost.
- **No new `.cu`/`.hip` files.** The "5 files only" rule from `GPU_SPLIT_PROMPT` is enforced on every heal output. A project that *should* be split across multiple TUs is a Phase-5 concern, not a heal-time decision.
- **Native lifecycle updates allowed and expected.** When an ABI-breaking edit lands as a side effect of a heal (rare but possible — e.g. Tier 2 splits one kernel into two), the healer is expected to natively patch `device_on_load` / `device_save_write` in the host modules in the same edit batch. This is the no-shim contract operating in reverse: the AI updates the serialization logic in place rather than writing a migration bridge.

These checks are mechanical, not LLM-judged. If the AI takes the easy path of "wrap the broken thing," the verifier fails the patch — and the next retry, if any, sees the rejection in its prompt.

### 11.5 Retry and bailout

Same `MAX_HEAL_RETRIES = 2` as §5.7 (3 total attempts). Telemetry per retry: tier, error class, whether the verifier rejected for shim emission, time to fix. If retries are exhausted, the raw error (plus any verifier-rejection notes) goes to the existing `CompileErrorCard.jsx` flow. Tier 3 runtime errors that exhaust retries additionally surface a "GPU runtime fault — open kernel" link that jumps to the offending line in `device.cu`, identified from the runtime error's PC if the cubin was built with `-lineinfo` (already in the recommended `gpu.device_flags` in §5.1).

### 11.6 Stream deadlock specifically

This is the case that has no error code, so it gets the most explicit handling — and is the cleanest demonstration of the no-shim discipline:

- The watchdog thread (§11.2) synthesizes `STREAM_HANG` records with the captured stream topology.
- Triage routes to Tier 3 with `error.kind = "stream_hang"`.
- `GPU_HEAL_RUNTIME_PROMPT` includes the launch graph + the stream/event DAG the runner already captures for tier-B userspace snapshots (§6). The AI sees who waited on whom.
- Healer patches the launch site directly: missing `cudaStreamWaitEvent`, circular event dependency, kernel launched on a destroyed stream, async memcpy missing its sync. Always edits the existing host launch code — never adds a "stream rescue" helper, never injects an extra sync stream as a band-aid.
- If the AI's patch passes the verifier but the hang reproduces, the runtime kicks the project into the existing drain-timeout fallback from §5.7: process kill + cold restart on next compile. The healer doesn't get a fourth attempt — at that point the project's launch graph likely needs human input.

### 11.7 Files added/edited for §11 (consolidated)

Already listed in §8, repeated here for legibility of this section:

**Create:**
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/ptxas_info_parser.rs` — record types + parser.
- `backend/synthi-webrtc-compiler/worker/src/runtime/gpu_runtime_watchdog.rs` — stream-latency watchdog producing `STREAM_HANG` records.
- `ai-backend/ai-engine/agents/gpu_error_triage.py` — non-LLM classifier mapping diagnostic records to heal tiers.

**Edit:**
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/compile_device.rs` — call the parser, attach `GpuToolchainDiagnostics` to the compile result.
- `ai-backend/ai-engine/llm/prompts.py` — three siblings `GPU_HEAL_COMPILE_PROMPT`, `GPU_HEAL_PERF_PROMPT`, `GPU_HEAL_RUNTIME_PROMPT` with a shared header.
- `ai-backend/ai-engine/agents/gpu_healer.py` — accepts the unified payload, dispatches to the right sub-prompt.
- `ai-backend/ai-engine/verifier_gpu.py` — no-shim rules: file-creation rejection, name-similarity wrapper detection, signature preservation.
- Worker → IDE RPC schema — add a `gpu_runtime_error` event variant (find the existing schema via the host compile-error event type).

## 12. Automation harness — `gpu-hmr-test.mjs`

The plan in §9 is executed automatically by `mcp/synthi-mcp/scripts/gpu-hmr-test.mjs`, modelled on `live-test.mjs`. The script is **forward-compatible** — it will run today against a worker that hasn't shipped GPU HMR yet and emit precise, actionable failures pinpointing which seam is missing. As each phase lands, more rows turn from `WARN (skipped: feature_flag_off)` into `PASS`.

### 12.1 What the harness does, end to end

1. **Preflight** (mirrors `live-test.mjs` Phase 1):
   - TCP-pings frontend/collab/signaling.
   - Probes the worker container for `nvcc` and/or `hipcc`. If neither is present, every per-phase row records `skipped: no_toolchain`; the harness still exercises the workspace-seeding wire (validates the §9.1 seed plumbing) and prints a clean summary.
   - Probes `SYNTHI_GPU_HMR` and the worker's `gpu-hmr` cargo feature via `synthi_health`'s extended capability block. If the flag is off, rows record `skipped: feature_flag_off`. This is the same shape `live-test-phase3.mjs` uses for unimplemented escape hatches — see lines 1007-1031 of `live-test.mjs`.
2. **Workspace seeding** (the §9.1 intricacies):
   - Creates a fresh slug via `POST /api/workspace`.
   - Writes 5 source files + `.synthi/build_manifest.json` in one `write-files-batch` call (single round-trip, atomic from the collab server's view).
   - Stages + commits.
3. **Per-phase suite**, each with its own assertions and recorded row:
   - **P0 (smoke)**: compile, scrape worker log for `compile-device`, assert cubin exists.
   - **P1 (cold reload)**: edit `device.cu`, compile, `synthi_wait_hmr`, screenshot before/after with pHash, assert `reload_plan=cold` (Phase-1 era) or `device_only` (Phase-2 era), assert buffer-pointer reuse.
   - **P2-cuda (fast swap)**: assert `total_ms ≤ SYNTHI_GPU_FAST_SWAP_BUDGET_MS`, assert `device_on_load` was NOT invoked.
   - **P2-rocm (parity)**: same but with `vendor:"rocm"`. Auto-skip if `hipcc` not present and `SYNTHI_GPU_HIP_FAKE_RUNTIME` unset.
   - **P3-mixed**: stateful fixture (accumulator), edit both sides, assert accumulator preserved, assert log-step sequence.
   - **P3-tier-toggle**: re-run mixed once per `snapshot_mode`, assert downgrade behavior on old drivers.
   - **P3-heal-T1/T2/T3**: inject the three pathological edits from §9.6, post to `/refactor/heal/gpu`, validate against the no-shim verifier rules.
   - **P3-stream-hang**: assert the watchdog's 5 s synthesis + drain-timeout fallback.
4. **Summary** (mirrors `live-test.mjs:1131-1144`):
   - Per-row PASS / WARN / FAIL with phase label.
   - Writes `results.json` + `results.txt` + per-phase screenshots and worker-log slices to `.gpu-hmr-test-{logs,artifacts}/`.
   - Exit code: 0 if zero FAIL; 1 otherwise. WARN never fails the run (it's the right signal for "feature not built yet" and "no Tier-A driver").

### 12.2 Running it

Single command from `mcp/synthi-mcp/`:

```
SYNTHI_GPU_HMR=1 \
  SYNTHI_GPU_VENDOR=cuda \
  GOOGLE_API_KEY=…  \
  node scripts/gpu-hmr-test.mjs
```

Environment variables (all optional, sensible defaults):

| Variable                              | Default                | Purpose                                                                                  |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `FRONTEND_URL`                        | `http://localhost:3000`| Next.js API for workspace creation.                                                       |
| `COLLAB_URL`                          | `http://localhost:1234`| Collab server for `write-files-batch` + git ops.                                          |
| `SIGNALING_URL`                       | `ws://localhost:9000`  | WebRTC signaling; used by `synthi_attach` if MCP is wired.                                |
| `AI_ENGINE_URL`                       | `http://localhost:8000`| AI engine for `/refactor/split/gpu`, `/refactor/heal/gpu`, etc.                          |
| `WORKER_LOG_PATH`                     | `<repo>/backend/synthi-webrtc-compiler/.run/worker.log` | Tailed by the harness for log markers.                |
| `SLUG`                                | `gpu-hmr-<ts>`         | Unique per run.                                                                          |
| `SYNTHI_GPU_VENDOR`                   | `cuda`                 | `cuda` or `rocm`; also set `both` to run both vendors back-to-back.                       |
| `SYNTHI_GPU_FAST_SWAP_BUDGET_MS`      | `300`                  | Phase-2 wall-clock budget.                                                               |
| `SYNTHI_GPU_LAUNCH_WATCHDOG_MS`       | `5000`                 | Used to set the expected stream-hang detection latency.                                  |
| `SYNTHI_GPU_DRAIN_TIMEOUT_MS`         | `2000`                 | Used to assert the drain-timeout fallback.                                               |
| `SYNTHI_GPU_HIP_FAKE_RUNTIME`         | unset                  | If set, harness sends a manifest flag asking the worker to load HIP-CPU instead of real ROCm. |
| `SKIP_PHASES`                         | empty                  | Comma list of phase ids to skip (e.g. `P3-stream-hang` for slow CI lanes).               |
| `ONLY_PHASES`                         | empty                  | Comma list of phase ids to run exclusively.                                              |
| `HMR_TIMEOUT_MS`                      | `60000`                | Per-edit HMR wait timeout.                                                               |

### 12.3 What it asserts vs the plan

Every numbered assertion in §9 has a row in `results.json`. The harness is the executable form of §9; if §9 changes, the harness's `expected.*` files (in `tests/fixtures/gpu/*/golden.json`) must change with it, and CI will catch drift between the two.

### 12.4 Pre-implementation behavior

Today, every GPU endpoint and every worker log marker described in §9 does not exist. Running the harness on current `main` produces:

- P0–P3 rows: `WARN  skipped: feature_flag_off` (because `SYNTHI_GPU_HMR=1` is read by code that doesn't exist yet).
- Workspace seed rows: `PASS` (the `write-files-batch` plumbing is real; the harness validates 5 files + manifest land on disk correctly via `synthi_get_source_state`'s content hash).
- Toolchain probe rows: `PASS` or `SKIP` based on whether `nvcc`/`hipcc` exist on the worker.
- Exit code: 0.

This is intentional: the harness is the **acceptance test** the implementor runs locally as each seam ships. The first thing it will do, the first day Phase 0 lands, is turn the P0 row green and immediately catch the `is_cpp_compiler` regression (§9.3) if anyone forgets it.
