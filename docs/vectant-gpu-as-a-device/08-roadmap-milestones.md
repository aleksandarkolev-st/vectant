# Vectant Roadmap & Milestones

Status: v0.2 (2026-08-24) · Planning only, no code
Supersedes: v0.1 draft
Sequencing principle (corrected per review): **prove the ABI and semantic
model on real hardware before any optimization machinery.** A simulator that
validates unproven loading/ABI assumptions would confidently validate an
architecture that cannot work. Correctness first; the network comes last.

The Superseding Rule governs every phase: *prediction may change when Vectant
sends work, but never what the application is told happened.*

---

## Phase 0A — Windows ABI spike (highest priority; before any simulator)

Goal: prove stock Windows CUDA software loads and drives a Vectant
`nvcuda.dll` proxy with no NVIDIA GPU/driver present.

- Environment: Windows 11, no NVIDIA driver, stock Python + PyTorch wheel.
- Deliverable: ugliest-possible local stub — no networking, no GPU — where
  `torch.cuda.is_available()` probes reach OUR `cuInit`, and we enumerate a
  synthetic device.
- Record empirically: every export requested at load and at runtime,
  versioned/undocumented symbols, DLL search-path behavior for the chosen
  deployment method, whether cuBLAS/cuDNN initialize against the proxy.
- Exit criterion: `import torch; torch.cuda.is_available()` executes our code
  path end-to-end on a driverless machine, and the full export-request list is
  captured as the compatibility workload's ground truth.
- This experiment outranks any simulation result.

## Phase 0B — Same-machine semantic proxy

Goal: correctness against REAL CUDA with zero network noise.

- Shim forwards to a host daemon on localhost driving the real GPU.
- Compare behavior vs native CUDA: pointer lifecycle, context management,
  callbacks, error codes, OOM paths, cuBLAS/cuDNN results bit-comparable
  within documented tolerance.
- Implement the §05 semantic model here: real remote addresses, synchronous
  arena allocation, confirmed-only status, client-side callbacks, dedup by
  command ID.
- Exit criterion: real PyTorch ops (matmul, conv, autograd step) produce
  native-matching outputs through the full shim→daemon→GPU→back path.

## Phase 0C — LAN separation

Goal: same system across two machines, sub-ms RTT.

- Real PyTorch/cuBLAS/cuDNN/autograd/stream/event/OOM test battery over
  genuine transport (QUIC), still far below WAN pain thresholds.
- Expose ordering/dedup/reconnect bugs cheaply: kill the connection mid-run,
  verify exactly-once via host-side dedup ledger.
- Exit criterion: external test repo runs green on LAN; reconnect mid-step
  loses nothing.

## Phase 0D — Network emulation + trace-driven simulation

Goal: NOW the simulator earns its place.

- Emulated links: 2/5/10/20/80 ms RTT, bandwidth caps (uplink ≠ downlink),
  jitter, loss, asymmetry. Run the 0C battery across the matrix.
- Trace-driven simulation for design constants only: α flush-law sweeps,
  PR hit rates, arena/suballocator churn — using traces captured in 0B/0C.
- Exit criterion: batching/prefetch defaults chosen from measured Pareto
  curves; protocol gaps enumerated from emulated-WAN failures (not guessed).

## Phase 1 — WAN CUDA alpha

Scope (deliberately narrow):

```text
Windows 11 client · NO local NVIDIA GPU required
stock app / stock PyTorch / stock cuBLAS-cuDNN (where supported)
        │ Vectant nvcuda forwarding shim (Tier-1)
        ▼ QUIC data plane (per 09)
        ▼ Linux vectant-hostd · VM-isolated · real NVIDIA driver
        ▼ exclusive physical GPU
```

Semantic model = `05` v0.2 exactly: host-confirmed device/context creation;
real allocations returning real stable addresses; posted async launches;
host-recorded truth pushed continuously (query true ONLY when confirmed);
blocking sync until confirmation; real D2H bytes with internal predictive
push; callbacks executed client-side; transparent resume only for
transport-loss-same-session; everything else → device-lost-class honesty.

**Explicitly unsupported in Phase 1** (surface native not-supported errors):
managed/unified memory · mapped/zero-copy host memory · CUDA IPC · graphics
interop · multiple local processes sharing the shim · local-NVIDIA +
Vectant-GPU coexistence (see Coexistence below) · Vulkan/DX12/OpenGL ·
MIG/shared GPUs · host migration/warm failover · anti-cheat environments ·
games.

Exit criterion: an external developer runs their own unmodified CUDA repo on
a rented GPU without Vectant internals knowledge; P95 step overhead targets
set from 0D curves, not aspiration.

## Phase 1.5 — Optimization (only what traces justify)

Command batching (flush law) · graph replay bundles · predictive readback ·
session/kernel caches · chunk-hash dedup for repeated uploads · arena VA
stabilization for session resume. Every mechanism must show measured win on
captured traces before shipping.

## Phase 2 — Compatibility breadth + coexistence

More CUDA surface (from 0A's recorded demand) · pinned-memory subset with
measured expectations · multi-context/multi-process support · managed-memory
degradation ladder (research-gated) · **local+remote GPU coexistence**
(below) · provider routing/billing maturity · persistent same-user caches.

## Phase 3 — Other APIs (separate programs, separate gates)

Vulkan headless/compute first (ICD is the honest path). Interactive graphics
only after its own research gate proves usefulness — Split-Present reclassified
as research requiring engine cooperation, not a generic escape hatch.
D3D12/WDDM IOCTL projection is its own major program, not "another frontend."

---

## Local + Remote Coexistence (the product promise gap)

Phase 1 targets machines with NO local NVIDIA stack (CPU/iGPU/AMD boxes) —
stated explicitly because the ultimate promise ("your existing PC + rented
GPU") requires the shim to expose BOTH the local GPU (device 0) and the
remote GPU (device 1), routing contexts/pointers/streams/events/enumeration
between two unrelated backends. That is a significant standalone milestone:
it needs a multiplexing frontend where each CUDA object is tagged with its
owning backend and cross-device operations degrade to copy bridges. Deferred
to Phase 2 by design, not overlooked.

---

## Risk Register

| # | Risk | Mitigation |
|---|---|---|
| 1 | nvcuda.dll proxy fails load/init on stock stacks | Phase 0A exists to kill or prove this FIRST; fallback tiers (02 §E) if deployment method breaks |
| 2 | Closed-source libs touch unsupportable internals | 0A export recording + fail-closed refusals ledgered; grow subset from recorded demand |
| 3 | Pointer-semantics edge cases (offset arithmetic, embedded pointers) | real-address model (05 §0); 0B differential testing vs native |
| 4 | Host driver attack surface from hostile clients | VM boundary per 07 §2; fuzz corpus CI gate |
| 5 | Provider/model instability during live proofs | bounded preflight timeouts; 0B/0C run on localhost/LAN first (repo lesson) |

## Immediate Next Actions

1. Phase 0A spike charter + environment spec (driverless Win11 box).
2. Define the 0B differential test battery (op list, tolerance policy).
3. Capture harness plan for API traces (feeds 0D simulation).
