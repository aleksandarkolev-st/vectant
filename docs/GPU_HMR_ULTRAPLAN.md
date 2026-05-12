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

## 9. Verification

Each phase has its own checkpoint:

1. **Phase 0 smoke.** Write a 20-line `vector_add.cu` project, hit Compile, confirm `compile_device.rs` produces a cubin and the host runner launches the kernel. Pure toolchain check.
2. **Phase 1 cold-reload.** Same project, edit only the kernel body (e.g. swap `+` for `*`), hit Compile, confirm the input buffer survives. A worker unit test asserts the same `cudaMalloc` pointer is reused across the swap.
3. **Phase 2 fast device swap.** Instrument the worker to log `reload_plan`. Edit kernel body → expect `device_only`, swap in <300ms. Edit a kernel parameter type → expect `abi_breaking` and cold reload. Repeat on ROCm via hipcc on an AMD GPU (or via HIP-CPU runtime in CI).
4. **Phase 3 mixed + driver checkpoint + healer.** Start a long-running kernel that maintains accumulator state across launches. Edit both host and device side mid-run. Confirm the accumulator survives. Toggle `gpu.snapshot_mode` between `driver_checkpoint` and `userspace` and verify both paths succeed. Three healer drills:
   - Tier 1: write a kernel calling a non-existent intrinsic; confirm `GPU_HEAL_COMPILE_PROMPT` fix natively replaces the call site in `device.cu` (no new file).
   - Tier 2: write a kernel with 200 local floats forcing register spills; confirm `GPU_HEAL_PERF_PROMPT` adds `__launch_bounds__` and/or moves the array to shared memory by editing `device.cu` in place.
   - Tier 3: write a kernel that indexes one past the buffer; confirm `GPU_HEAL_RUNTIME_PROMPT` fixes the bounds check directly in the kernel.
   - For all three: assert via `verifier_gpu.py` that the heal output added no new files and no `*_safe`/`*_v2`/`*_fallback` wrappers.
5. **Bench corpus.** Add `ai-backend/ai-engine/bench/corpus/gpu/` with `vector_add/`, `reduction/`, `gemm/` fixtures matching the existing `bench/corpus/<name>` shape. Each has a known-correct edit and an assertion that device state is preserved. Wire into `bench/harness.py`.

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
