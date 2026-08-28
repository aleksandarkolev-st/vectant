# Vectant GPU-as-a-Device — Architecture Document Set

Status: **v0.2** (2026-08-24) · Planning only, no code
Source concept: `vectant_gpu_as_a_device.md` (repo root)
v0.2 = full revision after external architecture review; v0.1's optimistic
allocation, API-visible speculation, fake-pointer model, host-side callbacks,
and idempotent-replay assumptions were rejected as correctness bugs.

## What this is

A complete planning package for Vectant: temporarily attaching a remote
physical GPU to a user's existing computer such that unmodified applications
(CUDA first) keep working, with no VM *on the user's side*, no remote
desktop, and no SDK integration. The network sits where PCIe sat; everything
follows from hiding a 10³–5×10⁴× latency penalty behind the asynchronous
command-queue boundary — without ever lying to the application.

## The Superseding Rule (governs every doc)

> Prediction may change when Vectant sends work — never what the application
> is told happened. All API-visible values/statuses come from host-confirmed
> facts. Allocation results are never speculated (Phase 1 makes them locally
> factual via an attach-time reserved VRAM arena).

## Documents

| Doc | Contents |
|---|---|
| `01-prior-art.md` | Cited forensics of relevant prior art: vCUDA/rCUDA/gVirtuS/Bitfusion/vGPU/VirGL-Venus/dxgkrnl/CXL/cloud-gaming/LUPINE/DxPU/ExpEther; five structural reasons transparency never shipped; untried combinations; inference disclosure |
| `02-api-compat.md` | CUDA/Vulkan/DX12 surface maps, compatibility matrix (S/M/L/XL), ranked blockers (CDP corrected: remote-only execution, not a wire problem), Tier 1–3 client ladder, Phase-1 nvcuda.dll function subset |
| `03-data-plane-design-space.md` | Quantified envelope math, transport comparison (QUIC-primary), remote-memory architectures incl. Transport-Aware Allocator [PROPOSED], sync taxonomy (speculation superseded → confirmed-truth), 12 rated mechanisms, top-10 decisions |
| `04-system-architecture.md` | Design Law + Superseding Rule + corollaries C1–C6, decomposition, control plane (repo signaling server as Attach Broker), client runtime (per-API recorders over SHARED SERVICES — not a unified IR — Ledger+arena, Placement Engine, Status Oracle, Batch Scheduler, Command Journal), host architecture, workload verdicts |
| `05-memory-and-sync-semantics.md` | REAL remote GPU virtual addresses returned to apps (opaque handles only for non-pointer resources), synchronous arena-backed allocation with native OOM honesty, confirmed-only status oracle, client-side callbacks, dedup-not-idempotence reconnect, three-way failure split |
| `06-performance-envelope.md` | RTT/bandwidth arithmetic (Mbit/s AND MB/s throughout, uplink/downlink modeled separately), sync budgets, LLM decode-loop honesty note (PR floors at GPU-finish + one-way propagation), training traffic corrected (gradients stay GPU-resident), unit-discipline mandate |
| `07-security-isolation-failure.md` | Both-direction threat model, VM-based host isolation (containers insufficient for hostile driver input), honest confidentiality limits, four-tier supply trust, F1/F2/F3 failure classes |
| `08-roadmap-milestones.md` | Corrected ladder: 0A Windows ABI spike FIRST → 0B localhost semantic proxy → 0C LAN → 0D network emulation/simulation → 1 WAN alpha (explicit unsupported list) → 1.5 trace-justified optimization → 2 breadth + local/remote coexistence → 3 other APIs as separate gated programs |
| `09-protocol-v0-sketch.md` | EXPLICITLY UNFROZEN wire sketch: version/ABI negotiation, feature bitmaps, incarnation IDs, precise RECEIVED/SCHEDULED/EXECUTED ACK semantics, reliable status framing with snapshots, credits/backpressure, cancellation, lifecycle ordering, no commands on 0-RTT |

## Research findings that shaped the thesis

- **The data plane has an existence proof**: LUPINE (open-source GPU-over-IP)
  demonstrates unmodified PyTorch against remote NVIDIA silicon on Linux.
  Vectant's territory: WAN-grade performance engineering, Windows-native
  attachment, and the commerce shell (`01` §LUPINE).
- **Intercept at the highest stable interface; forward to genuine drivers;
  never reimplement the API** (ZLUDA legal exposure) **and never emulate the
  bus** (ExpEther physics wall).
- **Synchronization density, not bandwidth, predicts per-workload pain** —
  the consistent 15-year literature finding (`03` §1, `06`).

## One-screen thesis

1. Insert the network at the existing async command-queue boundary — never
   between CPU instructions.
2. Keep state remote; steady-state traffic is small commands + deltas.
3. Return REAL remote addresses; allocate synchronously from a pre-reserved
   arena so success is fact, not forecast.
4. Cache host-emitted truth for polls; unknown completion is not-ready until
   confirmed. Predict only inside the runtime.
5. Execute callbacks client-side; guarantee exactly-once by host-side command
   dedup; resume transparently only while the same session lives.
6. Map every failure to an error apps already handle; prove the Windows ABI
   before building anything else.

Nothing here requires inventing physics — it requires combining known
mechanisms (driver-API forwarding, paravirtual ICDs, VMM-backed arenas,
QUIC streams) with proposed-but-unproven pieces ([PROPOSED] in docs 03/05):
Predictive Readback, the Status Oracle over confirmation vectors, and the
Transport-Aware Placement Engine — each gated on measured evidence from the
0B–0D phase ladder.
