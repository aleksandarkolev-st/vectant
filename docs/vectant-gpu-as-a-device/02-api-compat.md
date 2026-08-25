# API Compatibility Surface Analysis for a Remote GPU Client

**Vectant — GPU-as-a-Device · Research document (no code)**
Scope: precise map of the CUDA / Vulkan / Direct3D 12 / OpenGL surfaces a wire-compatible remote-GPU client must reimplement, difficulty-rated, with a minimal Phase-1 slice. Client-first target: Windows 11. The app stays local; the GPU executes in a datacenter host; Vectant sits *under* CUDA/D3D/Vulkan/OpenGL ([concept doc](vectant_gpu_as_a_device.md)); remote state persists for session lifetime.

Difficulty scale: **S** = days–weeks; **M** = weeks–months; **L** = months–quarters of engineering; **XL** = research-grade or contractually blocked.

---

## A. CUDA on Windows

### A.1 Layering — one chokepoint

CUDA's Windows stack is:

```text
app → libcudart (static or cudart_*.dll), cublas.dll, cudnn.dll, …   [local CPU code]
        ↓ all GPU work
nvcuda.dll  (= libcuda, the driver API)  →  WDDM/KMD → GPU
```

The runtime is documented as a layered convenience wrapper over the driver: "the Runtime API is implemented by forwarding calls to the Driver" ([NVIDIA Programming Guide, Driver API section](https://docs.nvidia.com/cuda/cuda-programming-guide/03-advanced/driver-api.html); also [Modal's GPU glossary](https://modal.com/gpu-glossary/host-software/cuda-runtime-api)). NVIDIA ships no source for the math libraries, but three independent lines of evidence converge on "all GPU work funnels into nvcuda.dll":

1. **Symbol dependency dumps**: `dumpbin /dependents` on `cublas.dll`, `cudart64_*.dll`, `cudnn64_9.dll`, `cufft64*.dll`, `curand64*.dll`, `cusparse64*.dll`, `cusolver64*.dll`, and `nvrtc-builtins64_*.dll` lists exactly one NVIDIA binary dependency: `nvcuda.dll`. Community nvcuda re-implementations (Wine's standalone nvcuda, [github.com/SveSop/nvcuda](https://github.com/SveSop/nvcuda), requiring "driver 525 series or newer") confirm the surface is load-bearing.
2. **ZLUDA** — a drop-in `libcuda` replacement that runs unmodified CUDA apps on AMD GPUs ([github.com/vosen/ZLUDA](https://github.com/vosen/ZLUDA)) — proves a single user-mode chokepoint suffices for real workloads including PyTorch, cuBLAS-heavy stacks, and PhysX ([discussion #31](https://github.com/vosen/ZLUDA/discussions/31)).
3. **Remote-GPU middleware** (rCUDA [overview](https://en.wikipedia.org/wiki/RCUDA), [CCGrid'17 paper](https://dl.acm.org/doi/pdf/10.1109/CCGRID.2017.42); GVirtuS [repo](https://github.com/gvirtus/GVirtuS)) intercepts at the same layer with application transparency.

**Verdict: nvcuda.dll is the only chokepoint needed.** No WDDM/D3DKMT involvement is required for compute-only CUDA on Windows — the driver API talks to the kernel via private ioctls, but a shim above it never sees them. This is the strongest architectural fact in Vectant's favor.

### A.2 Feature categories a faithful shim must handle

| Category | Contents | Difficulty |
|---|---|---|
| Context mgmt | `cuInit`, `cuCtxCreate`, primary context (`cuDevicePrimaryCtxRetain`, [ref](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__PRIMARY__CTX.html)), current-context TLS (`cuCtxSetCurrent`), flags (spin/yield/sched flags + `CU_CTX_LMEM_RESIZE_TO_MAX`) | S |
| Module loading & JIT/PTX | `cuModuleLoad*` (cubin/fatbin/PTX from memory), `cuLinkAddData` full linker, `cuModuleGetFunction`, PTX JIT options cache ([SO example](https://stackoverflow.com/questions/60191445/ptx-jit-compilation-failed-from-cumoduleloaddata)) | M |
| Kernel launch | `cuLaunchKernel(Ex)` with param buffers, launch attributes incl. `CU_LAUNCH_ATTRIBUTE_COOPERATIVE`; cooperative launch `cuLaunchCooperativeKernel` ([EXEC ref](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXEC.html)); **dynamic parallelism CDP** (kernels launching kernels on-device): device-side launches execute entirely on the remote GPU and need NO wire round trips; the real difficulty is tail-launch scheduling/dependency machinery inside the host replay engine plus module/heap context, so support is deferred as hard-but-not-blocker, not rejected | L (CDP XL) |
| Memory: linear/pitched | `cuMemAlloc`, pitched `cuMemAllocPitch`, 2D/3D memcpy variants (`cuMemcpy2D/3D` + async + Batched) | M |
| Arrays & mipmaps | `cuArray3DCreate`, mipmapped arrays, surface/texture descriptors, `cuTexObjectCreate` TMA descriptors | M→L |
| Managed/unified memory | `cudaMallocManaged`, page-fault-driven migration (needs GPU page-faulting HW, since Pascal per [UM & NVLink-C2C](https://ai-infrastructure.net/cuda-unified-memory)); `cudaMemAdvise`/`MemPrefetchAsync` semantics per [docs](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY.html). Emulation ladder in §A.3 | L |
| Pinned/host-registered | `cudaMallocHost`/`cudaHostAlloc`/`cudaHostRegister` ([legacy ref](https://developer.download.nvidia.com/compute/DevZone/docs/html/C/doc/html/group__CUDART__MEMORY_g36b9fe28f547f28d23742e8c7cd18141.html)); GPUDirect RDMA assumes NIC/GPU share PCIe ([docs](https://docs.nvidia.com/cuda/gpudirect-rdma/index.html)) | M (perf risk) |
| IPC handles/events | `cudaIpcMemHandle_t` etc. — spec says "same machine, same OS" only ([Programming Guide §4.15](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/inter-process-communication.html); handle struct [here](https://docs.nvidia.com/cuda/13.0/cuda-runtime-api/group__CUDART__IPC.html)) — same-process assumption makes this a non-feature locally; return not-supported | S |
| Streams/events/callbacks/graphs | stream priorities, events, host fn callbacks (fire client-side at event completion), CUDA Graphs instantiate/upload/launch/exec-update; graph upload = serialize instantiated topology once | L |
| Stream-ordered allocator | `cudaMallocAsync`/`cudaFreeAsync` mempools ([runtime ref](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY__POOLS.html); guide §4.3 [here](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/stream-ordered-allocation.html)) — pool release threshold must be tracked server-side; IPC-on-pools requires explicit handle export ([UCX issue #7110](https://github.com/openucx/ucx/issues/7110)) | M |
| Green contexts | `cuGreenCtxCreate` SM partitioning ([driver ref group](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__GREEN__CONTEXTS.html); [Programming Guide §4.6](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/green-contexts.html)) | M |
| MPS | MPS turns each process context into a client of an MPS server process ([architecture doc](https://docs.nvidia.com/deploy/mps/architecture.html)); irrelevant to a single-tenant remote session — report unsupported or silently single-client | S |
| Occupancy/device props/NVML | occupancy functions run local against remote truth table; ~500 attributes incl. cluster dims; NVML = separate nvml.dll monitoring API ([dev page](https://developer.nvidia.com/management-library-nvml), [API ref](https://docs.nvidia.com/deploy/nvml-api/index.html)) — proxy queries to host | S/M |
| Error model | `CUresult` codes apps branch on: out-of-memory vs invalid-value branching, `cuCtxSynchronize` returning context-lost-class errors after network loss must be mapped to `CUDA_ERROR_DEVICE_UNAVAILABLE`-class codes | M |

### A.2.1 Interop surfaces (hardest)

D3D/GL/Vulkan interop (`cudaGraphicsD3D12RegisterResource`, external memory import/export `cuImportExternalMemory`, `cuImportExternalSemaphore` ([EXTRES_INTEROP group](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXTRES_INTEROP.html); modern path explained in [CUDA handbook ch.3.11](https://cudahandbook.com/book/ch3/external-memory-and-graphics))) requires the SAME physical buffer to be addressable by two drivers on one machine. Over the wire, there is zero shared physical memory between local D3D UMDs and the remote GPU — interop becomes a copy bridge: register → staged upload/download through Vectant transport. Correct but slow; classify XL to make fast, L to make correct-but-slow.

### A.3 Unified/managed memory: exact mechanics and WAN degradation ladder

Local mechanics ([UM overview](https://ai-infrastructure.net/cuda-unified-memory)): since Pascal, `cudaMallocManaged` allocations live in GPU page tables and migrate at **4KB/2MB page granularity on demand** — a GPU access to a non-resident page raises a GPU page fault, the driver stalls the touching work, invalidates CPU mappings, copies pages, rebuilds page tables, resumes. `cudaMemAdvise(ptr, len, cudaMemAdviceReadMostly/PREFERRED_LOCATION, dev)` sets policy hints; `cudaMemPrefetchAsync` starts migration early, overlapped with compute. Apps also rely on *oversubscription* (allocations larger than VRAM thrash transparently).

Over a WAN each fault costs ≥1 RTT plus bulk transfer — pathological thrash would be catastrophic. Degradation ladder, faithful → cheap:
1. **Prefetch-honoring emulation**: implement `cudaMemPrefetchAsync` as eager wire transfer + `cudaMemAdvise` as client-side placement policy; serve real faults (detected via host-side SEH/VEC on the local mapping) by pulling pages remotely — correct semantics, worst-case slow. 
2. **Preferred-location pinning**: treat PREFERRED_LOCATION as binding (data lives either locally or remotely per advise), faults become explicit transfers; most ML code that prefetches before kernels never notices.
3. **Coarse-grained fallback (pre-Pascal semantics)**: map managed memory to zero-copy-style access through the transport (each CPU read/write becomes an RPC); report `cudaDevAttrPageableMemoryAccessUsesHostPageTables`-class attributes honestly so aware apps adapt.
Phase 1 takes none of these — returns not-supported — because PyTorch's default allocator does not use managed memory.

### A.4 Long-tail risk: closed-source internals

The math libraries are closed source and may call **non-public driver-internal entry points** (the `cu***v2` versioned ABI, internal context-lock helpers). ZLUDA's history is instructive: it works by reimplementing the *public* surface and reverse-engineering gaps as they appear — each new app can surface a new missing internal ([ZLUDA repo](https://github.com/vosen/ZLUDA)). Mitigation: run a broad app corpus (torch, TF, ONNX-Runtime, Blender CUDA backend, DaVinci) against the shim with an API-call logger from day one; treat any unexpected import as a P0 gap. This long tail is bounded but never provably empty.

---

## B. Vulkan

### B.1 What a remote-backed ICD must implement

A Vulkan ICD on Windows ships (a) a DLL exporting `vk_icdGetInstanceProcAddr` (+ optional `vk_icdNegotiateLoaderICDInterfaceVersion`, `vk_icdGetPhysicalDeviceProcAddr`) and (b) a JSON manifest discovered via registry key `SOFTWARE\Khronos\Vulkan\Drivers` or the default `C:\Windows\System32\` path convention — contract defined in the [Vulkan loader ICD interface doc](https://github.com/KhronosGroup/Vulkan-Loader/blob/main/docs/LoaderInterface.md) (driver-facing portion of [LoaderDriverInterface.md](https://github.com/KhronosGroup/Vulkan-Loader/blob/master/docs/LoaderDriverInterface.md)). The ICD then implements the full `vk*.h` device/instance function table for whatever extensions it advertises. A remote ICD advertises exactly what the host GPU + transport support; the loader handles app-facing version negotiation.

### B.2 The crucial insight: recording is local, submission crosses the wire

Command-buffer **recording** (`vkBeginCommandBuffer` → bind pipelines, push descriptors, draw/dispatch → `vkEndCommandBuffer`) is pure CPU work against client-side state tracking — zero network traffic if the remote ICD keeps a shadow of all Vulkan objects. Only `vkQueueSubmit` (and `vkQueuePresentKHR`, waits) serialize. This mirrors Venus: "defines the serialization of Vulkan commands between guest and host" ([Mesa Venus docs](https://docs.mesa3d.org/drivers/venus.html), [Collabora writeup](https://www.collabora.com/news-and-blog/blog/2022/10/19/a-look-at-vulkan-extensions-in-venus/)), and gfxstream's stream-server architecture ([google/gfxstream](https://github.com/google/gfxstream), [AOSP README](https://android.googlesource.com/platform/hardware/google/gfxstream/+/cd180b0a/README.md)).

Serialization strategy: encode each recorded command buffer as a compact token stream referencing object IDs (pipeline, descriptor sets, buffers/views) resolved at submit time; batch N command buffers per submit into one wire message; piggyback semaphore signals/waits. Pipeline creation serializes once (shaders as SPIR-V blobs + create-info structs); **shader compilation happens in-driver host-side** — so the REMOTE driver compiles SPIR-V→ISA, meaning pipeline layout compatibility checks, specialization-constant folding, and pipeline caches must live server-side; the client just ships SPIR-V and caches returned handles. Descriptor sets: either serialize `WriteDescriptorSet` batches verbatim (simplest, Venus-style) or implement descriptor buffering/update-after-bind faithfully client-side (harder).

Difficulty ratings:
- Core instance/device/queue/commands: **M**
- Pipelines + shader compile delegation: **M** (cache coherence adds L)
- Descriptor sets incl. BINDLESS/descriptor heaps (`VK_EXT_descriptor_buffer`): **L**
- Synchronization2/timeline semaphores over WAN: **L** — timeline values are monotonic counters; a remote ICD can ack locally and reconcile asynchronously, but `vkWaitSemaphores` with a timeout forces a round trip unless the value is locally predictable
- External memory/fences (`VK_KHR_external_memory_win32`, `external_semaphore_win32`): **XL blocker** — these exist precisely to share D3D12/Vulkan/DXGI objects in-process ([spec sync chapter](https://docs.vulkan.org/spec/latest/chapters/synchronization.html)); no cross-machine equivalent without shipping bytes; must advertise unsupported and accept app fallbacks
- Sparse residency (`VK_SPARSE_IMAGE...`, [spec sparsemem chapter](https://docs.vulkan.org/spec/latest/chapters/sparsemem.html), [Khronos guide](https://github.com/KhronosGroup/Vulkan-Guide/blob/main/chapters/sparse_resources.adoc)): **L** — queue sparse-binding ops serialize like submits, but page-table semantics must match remotely; doable, rarely exercised
- Swapchain/present: **L** — headless path: implement `VK_KHR_display`/`VK_EXT_headless_surface` alternatives or a Vectant-specific WSI returning images whose contents stream back as video; readback paths (`vkCmdCopyImageToBuffer` after acquire) serialize like memcpys

Prior art summary: Venus (virtio-gpu Vulkan serialization, renderer in virglrenderer), gfxstream (Android emulator streaming incl. Vulkan), Mesa `dozen`/"dzn" — Microsoft's D3D12-on-Vulkan layer now >99% conformance ([Phoronix](https://www.phoronix.com/news/Micorosft-Dzn-99p-Vulkan), [WSLg issue #1340](https://github.com/microsoft/wslg/issues/1340)) — proves a full API-over-API implementation is feasible at conformance level. All three validate the "shadow objects + submit-only serialization" design.

---

## C. DirectX 12

### C.1 Layering

```text
App → d3d12.dll (Agility SDK optional, [blog](https://devblogs.microsoft.com/directx/gettingstarted-dx12agility))
    → DXGI (dxgi.dll: adapter/swapchain)
    → dxgkrnl.sys / D3DKMT (kernel graphics port; [architecture doc](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/directx-graphics-kernel-subsystem))
    → vendor UMD (nvwgf2umx.dll etc.) → KMD → GPU
```

WDDM explicitly splits user-mode and kernel-mode components ([WDDM architecture](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/windows-vista-and-later-display-driver-model-architecture)); `D3DKMTSubmitCommand` is the kernel submission entry for user-mode-generated command buffers ([ddi ref](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/nf-d3dkmthk-d3dkmtsubmitcommand)). The Agility SDK lets apps load a newer d3d12.dll than the OS — a shim must handle both.

### C.2 What a USER-MODE-only remote implementation can intercept

Three viable interception points, none requiring kernel code:
1. **Proxy swapchain + adapter filtering**: replace `CreateDXGIFactory1`/`D3D12CreateDevice` exports via DLL shim chain so enumeration returns a virtual adapter backed by Vectant; CreateDevice returns our device object.
2. **DLL shim**: place vectant_d3d12.dll earlier in loader search order than system d3d12.dll; forward everything, intercept device methods.
3. **Proxy UMD**: too fragile (vendor-signed binaries, signature checks) — not recommended.

Command-list recording locality mirrors Vulkan: `ID3D12GraphicsCommandList::Close()` produces a blob; only `ExecuteCommandLists` on a command queue crosses the wire. Fence/event semantics: `Signal`/`Wait` on `ID3D12Fence` with `FenceEvent` — CPU-visible fence values can be tracked locally with async reconciliation; blocked `Wait` requires round trip unless predictable. Descriptor heap serialization: CBV/SRV/UAV heaps are GPU-visible descriptors — the wire format must carry resource views (GPU VA + format + range); this is well-trodden (see dozen/dzn mapping D3D12 descriptors onto Vulkan). Reserved/tiled resources map to remote SVT pages — manageable but L-difficulty. Present: DWM composition means every frame ends in a shared surface consumed by the compositor ([composition swapchain guide](https://learn.microsoft.com/en-us/windows/win32/comp_swapchain/comp-swapchain)); a remote GPU cannot feed DWM directly, so present forces a pixel-return path: hybrid architecture where API commands go over the Vectant transport but final frames come back as video/H.264/AV1 into a local composition surface.

Microsoft's own paravirtualization is the reference design: GPU-PV exposes a virtual compute device to guests; WSL2's `/dev/dxg` kernel driver speaks the D3DKMT protocol over VM bus to the host's dxgkrnl ([DirectX ❤ Linux blog](https://devblogs.microsoft.com/directx/directx-heart-linux), [LWN dxgkrnl overview](https://lwn.net/Articles/881311), [GPU paravirtualization doc](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-paravirtualization), [XDC 2020 slides](https://lpc.events/event/9/contributions/610/attachments/700/1295/XDC_-_WSL_Graphics_Architecture.pdf)). Vectant replaces "VM bus" with "WAN" but inherits the same protocol shape: guest/user-mode runtime ↔ host back-end, command+resource serialization, no guest kernel driver needed for the API layer itself.

Difficulty: basic D3D12 device+command+fence remoting **L**; full feature parity (raytracing pipelines, mesh shaders, enhanced barriers, work graphs) **XL**; swapchain/present video loopback **L**.

---

## D. OpenGL — verdict

Immediate-mode GL generates enormous per-call chattiness (glVertex*, immediate uniform updates, legacy display lists); naive wire protocols drown. Virgl exists for VMs ([Mesa VirGL docs](https://docs.mesa3d.org/drivers/virgl)) but is notoriously hard to keep conformant; Collabora's 2025 survey notes OpenGL virtualization now typically routes through Zink→Venus rather than native GL protocol ([Collabora](https://www.collabora.com/news-and-blog/blog/2025/01/15/the-state-of-gfx-virtualization-using-virglrenderer/)). A Gallium remote frontend is feasible research but not product. **Recommendation: defer OpenGL entirely; revisit only after Vulkan works, then route via Zink-style translation.**

---

## E. Windows Client Integration Ladder

Ranked by invasiveness:

### Tier 1 — Proxy-DLL/API shim (user mode, no admin install beyond file drop)
Replace nvcuda.dll exports (CUDA), provide ICD manifest (Vulkan), shim d3d12.dll (DX12).
- ✅ No kernel involvement; PatchGuard-safe; no signing required for test-signing-free operation; trivially uninstallable.
- ❌ DLL search-order hijacking concerns; some apps resolve absolute System32 paths and bypass shims; anticheat may still flag unsigned modules in game processes.
- Legal note: redistributing NVIDIA-named DLLs is prohibited — ship *our own* nvcuda.dll implementing the public API, never patch theirs. Clean-room reimplementation based on public headers/docs.

### Tier 2 — Service-installed user-mode runtime w/ DLL injection
A Windows service injects vectant_runtime.dll into target processes (or uses AppInit_DLLs / IFEO).
- ✅ Works even when apps bypass shims; can hook deeper (e.g., cudaMallocAsync pools).
- ❌ Injection breaks under AppContainer (UWP games), EasyAntiCheat/BattlEye treat injection as cheating ([EAC](https://www.easy.ac/en-us/partners/)), signature requirements escalate; service install needs admin.
- Legal/ToS risk: injecting into third-party software may violate game ToS even when technically possible.

### Tier 3 — Kernel virtual device (virtual PCI function, IVSHMEM-like bus, custom dxgk filter)
Expose a fake PCIe GPU or a Hyper-V-style virtual compute device; write a KMDF bus driver + optionally a DxgkDdi filter.
- ✅ True OS-level device visibility; could eventually support WDDM-native rendering paths.
- ❌ Kernel driver signing (WHQL/EV cert) mandatory; PatchGuard guards against SSDT/idt tampering but a legitimate signed filter driver is allowed yet scrutinized; bugchecks = BSODs on customer machines; massive maintenance burden across Windows updates.
- Verdict: Phase 1 should NOT go here. Revisit for Tier-3 only when user-mode ceiling proven insufficient.

**Recommended ladder position for Phase 1: Tier 1** — CUDA-only via nvcuda.dll proxy + minimal Vulkan ICD skeleton later.

---

## F. Compatibility Matrix

Rows = features; cells = difficulty S/M/L/XL + note.

| Feature | CUDA | Vulkan | DX12 |
|---|---|---|---|
| Device enumeration & props | S (report remote truth) | M (physical-device vtable) | M (adapter filtering) |
| Context/device creation | S | M | M |
| Memory allocation (linear) | M | M | M |
| Pinned/host-visible memory | M (no DMA; copies) | M | M |
| Unified/managed memory | L (emulate; see §A.3) | n/a | n/a (reserved res. = L) |
| Kernel/command serialization | M | M (record local, submit wire) | M (same shape) |
| Shader/kernel compilation | M (PTX JIT remotely) | M (SPIR-V compiled remotely) | M (DXIL validated remotely) |
| Cooperative launch / CDP / workgraphs | L / L (CDP remote-only; host-side tail-launch machinery is the cost, not the wire) | L | XL |
| Sync primitives (events/fences/timelines) | M | L (timeline over WAN) | L |
| Graphs / render-pass reuse | L | M (secondary bufs) | L |
| Stream-ordered allocator/mempools | M | n/a (allocator ext) | n/a (heaps) |
| Interop w/ other APIs | XL (copy bridge only) | XL (external mem) | XL |
| Swapchain/present | n/a | L (headless/video) | L (DWM video loopback) |
| IPC handles | S (not-supported) | n/a | n/a |
| NVML/monitoring proxies | S/M | n/a | n/a |

---

## G. Top-10 Hard Blockers (ranked)

1. **Unified memory page-fault emulation** — CUDA apps assume transparent migration; WAN latency makes naive emulation pathological (§A.3).
2. **External memory / interop across APIs** — fundamental physical-memory-sharing assumption broken; only copy bridges possible (§A.2.1, §B.2).
3. **Dynamic parallelism (CDP)** — device-side launches never cross the wire; the blocker is host-side tail-launch scheduling/fault-handling machinery in the replay engine (§A.2).
4. **Pinned-memory performance cliff** — correctness easy, performance brutal over WAN (§A.2).
5. **Timeline semaphore/fence wait round trips** — synchronization-heavy workloads stall (§B.2, §C.2).
6. **Shader compilation locality** — PTX JIT and SPIR-V→ISA must happen remotely; JIT cache coherence is subtle (§A.2, §B.2).
7. **Swapchain/present pixel return** — DWM composition forces a video path for DX12/Vulkan presentation (§C.2).
8. **Closed-source library long tail** — cuBLAS/cuDNN may touch undocumented driver internals (§A.4).
9. **Anticheat / AppContainer hostility to injection/shims** (Tier 2) — gaming use case partially blocked (§E).
10. **Kernel-tier signing + PatchGuard constraints** (Tier 3) — legal + operational cost (§E).

---

## H. Recommended Phase-1 Subset

Goal per tasking: make `torch.cuda.is_available()` true AND a real cuBLAS matmul run correctly remotely, using unmodified PyTorch wheels.

Scope:
1. **nvcuda.dll proxy implementing the driver API** (Tier-1 shim). Functions needed (public names, v2 suffixes):
   - `cuInit`, `cuDriverGetVersion`
   - `cuDeviceGet*`, `cuDeviceGetAttribute`, `cuDeviceGetName`, `cuDeviceTotalMem`, `cuDeviceGetCount`
   - `cuCtxCreate`, `cuCtxDestroy`, `cuCtxSetCurrent`, `cuCtxGetCurrent`, `cuCtxSynchronize`, primary-context family (`cuDevicePrimaryCtxRetain/Release`)
   - `cuMemAlloc`, `cuMemFree`, `cuMemcpyHtoD(Async)`, `cuMemcpyDtoH(Async)`, `cuMemsetD8/32`
   - `cuModuleLoadData(FatBin)`, `cuModuleGetFunction`, `cuModuleUnload`
   - `cuLaunchKernel` (basic grid/block/shared-mem params; no cooperative launch, no CDP in Phase 1)
   - `cuStreamCreate/Destroy/Synchronize`, `cuEventCreate/Record/Elapsed/Destroy`, `cuStreamWaitEvent`, `cuStreamAddCallback` (fire client-side)
   - Error codes mapped honestly; anything else returns NOT_SUPPORTED loudly (fail-closed per house rules).
2. **Remote truth table**: device properties (name=RTX 5090, SM count, VRAM size, arch sm_120) served from control-plane metadata, cached client-side.
3. **Transport**: gRPC/QUIC or raw TCP with TLS + length-prefixed protobuf-ish frames; commands: Alloc/Free/Memcpy/Launch/ModuleLoad/Sync/Event. Batch aggressively; async memcpy streams.
4. **Host side**: real CUDA driver on the datacenter box executing proxied calls in a 1:1 session context; session teardown clears state.
5. **PyTorch integration check**: torch.cuda.is_available() probes cuInit + device count + attrs + primary ctx retain + a trivial module load/launch (add kernel) + memcpy roundtrip. All above functions cover it.
6. **cuBLAS matmul**: PyTorch wheel bundles `cublas64_12.dll` (plus `cublasLt64_12.dll`); per §A.1 its NVIDIA binary dependency is nvcuda.dll alone. We do NOT reimplement cublas — since cuBLAS internally issues all GPU work through nvcuda.dll, our nvcuda proxy already carries it. Verify empirically in a Phase-0 spike: `dumpbin /dependents cublas64_12.dll` must list only nvcuda.dll + system DLLs.
7. **Explicit non-goals for Phase 1**: unified memory, pinned host alloc (return not-supported initially; torch falls back to pageable), IPC, graphs, interop, green contexts, MPS, NVML, D3D12/Vulkan/OpenGL.

Risks to watch: (a) cuBLAS may call `cuMemAllocAsync`/pool APIs on newer versions — add mempool stubs returning simple alloc; (b) cuBLAS heuristics query occupancy & SM stats — serve from truth table; (c) cuDNN/cuDSS out of scope until matmul proven; (d) some builds use static cudart — those bypass cudart dll but STILL route through nvcuda.dll (chokepoint holds).

Success criterion: `python -c "import torch; print(torch.cuda.is_available())"` → True on a machine with NO local NVIDIA GPU/driver installed, followed by `torch.randn(4096,4096,device='cuda') @ torch.randn(4096,4096,device='cuda')` completing with numerically correct results vs CPU reference.

---

## Sources

Primary NVIDIA docs:
- CUDA Programming Guide — Driver API layering: https://docs.nvidia.com/cuda/cuda-programming-guide/03-advanced/driver-api.html
- Driver API groups: EXEC https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXEC.html · PRIMARY_CTX https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__PRIMARY__CTX.html · GREEN https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__GREEN__CONTEXTS.html · EXTRES https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__EXTRES__INTEROP.html
- Runtime API: MEMORY https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY.html · POOLS https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY__POOLS.html · INTEROP https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__INTEROP.html
- Unified memory mechanics: https://ai-infrastructure.net/cuda-unified-memory
- GPUDirect RDMA: https://docs.nvidia.com/cuda/gpudirect-rdma/index.html
- IPC: https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/inter-process-communication.html
- Green contexts guide: https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/green-contexts.html
- MPS architecture: https://docs.nvidia.com/deploy/mps/architecture.html
- NVML: https://developer.nvidia.com/management-library-nvml · https://docs.nvidia.com/deploy/nvml-api/index.html
- cudaHostRegister (legacy ref): https://developer.download.nvidia.com/compute/DevZone/docs/html/C/doc/html/group__CUDART__MEMORY_g36b9fe28f547f28d23742e8c7cd18141.html

Vulkan:
- Loader ICD contract: https://github.com/KhronosGroup/Vulkan-Loader/blob/master/docs/LoaderDriverInterface.md
- Venus: https://docs.mesa3d.org/drivers/venus.html · Collabora deep-dive: https://www.collabora.com/news-and-blog/blog/2022/10/19/a-look-at-vulkan-extensions-in-venus/
- gfxstream: https://github.com/google/gfxstream
- dozen/dzn: https://www.phoronix.com/news/Micorosft-Dzn-99p-Vulkan · https://github.com/microsoft/wslg/issues/1340
- Sparse: spec https://docs.vulkan.org/spec/latest/chapters/sparsemem.html · guide https://github.com/KhronosGroup/Vulkan-Guide/blob/main/chapters/sparse_resources.adoc
- Sync: https://docs.vulkan.org/spec/latest/chapters/synchronization.html

DirectX / WDDM:
- WDDM architecture: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/windows-vista-and-later-display-driver-model-architecture
- Graphics kernel: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/directx-graphics-kernel-subsystem
- D3DKMTSubmitCommand: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/d3dkmthk/nf-d3dkmthk-d3dkmtsubmitcommand
- Agility SDK: https://devblogs.microsoft.com/directx/gettingstarted-dx12agility
- Composition swapchains: https://learn.microsoft.com/en-us/windows/win32/comp_swapchain/comp-swapchain
- GPU-PV: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-paravirtualization
- WSL dxgkrnl: https://devblogs.microsoft.com/directx/directx-heart-linux · https://lwn.net/Articles/881311 · XDC slides https://lpc.events/event/9/contributions/610/attachments/700/1295/XDC_-_WSL_Graphics_Architecture.pdf

OpenGL:
- VirGL: https://docs.mesa3d.org/drivers/virgl
- Collabora 2025 state-of-gfx-virtualization: https://www.collabora.com/news-and-blog/blog/2025/01/15/the-state-of-gfx-virtualization-using-virglrenderer/

Prior art:
- ZLUDA: https://github.com/vosen/ZLUDA (PhysX discussion #31)
- rCUDA: https://en.wikipedia.org/wiki/RCUDA · paper https://dl.acm.org/doi/pdf/10.1109/CCGRID.2017.42
- GVirtuS: https://github.com/gvirtus/GVirtuS
- Wine nvcuda standalone: https://github.com/SveSop/nvcuda

Licensing/legal:
- NVIDIA vGPU licensing: https://docs.nvidia.com/vgpu/latest/grid-licensing-user-guide/intro-to-grid-licensing.html · product terms https://www.nvidia.com/en-us/agreements/enterprise-software/product-specific-terms-for-vgpu-products/
