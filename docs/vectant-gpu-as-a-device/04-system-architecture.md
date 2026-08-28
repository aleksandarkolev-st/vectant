# Vectant System Architecture — GPU-as-a-Device

Status: DRAFT v0.1 (2026-08-23) · Planning only, no code
Companion docs: `01-prior-art.md`, `02-api-compat.md`, `03-data-plane-design-space.md`,
`05-memory-and-sync-semantics.md`, `06-performance-envelope.md`,
`07-security-isolation-failure.md`, `08-roadmap-milestones.md`

---

## 0. Design Law and Corollaries

Everything in this document derives from one physical fact: PCIe delivers
round trips in ~1–2 µs; consumer internet paths deliver them in 2–100 ms. That
is a 1,000×–50,000× penalty. Therefore:

> **THE LAW:** The wire may carry exactly three things:
> (a) **bulk bytes** whose transfer cost is amortized by large downstream GPU work,
> (b) **command streams** sent fire-and-forget (no acknowledgement in the hot path),
> (c) **deferred results** the application asked to consume later anyway.
> Any synchronous request/response inserted into a GPU hot loop is a design bug.

> **SUPERSEDING RULE (v0.2, governs everything below):**
> Prediction may change *when Vectant sends work* — never *what the
> application is told happened*. Every value, status, or completion state
> returned through a native API call originates from host-confirmed facts.
> Allocation results, event queries, fence values, and readbacks are never
> speculated, predicted, or optimistically answered.

Corollaries that shape every component:

1. **C1 — Insert the network at the existing async boundary.** Modern GPU APIs
   are already asynchronous command queues (CUDA streams, D3D12 command lists,
   Vulkan command buffers). The industry spent fifteen years moving from
   immediate mode to deferred submission precisely so slow CPUs could feed fast
   GPUs. Vectant places the network *at that already-existing queue boundary*,
   not between CPU instructions. This is the single most important structural
   insight: we do not need to invent asynchrony; we need to preserve it.
2. **C2 — State lives remote.** Assets (weights, textures, geometry, compiled
   kernels) upload once per session into persistent remote VRAM. Steady-state
   traffic is small commands + small deltas.
3. **C3 — Decide locally only what is locally decidable.** Anything the CPU
   decides without needing a GPU-produced value is decided against local
   bookkeeping: scheduling, batching, prefetch, cache placement. Allocation
   success is NOT in this class — it is made locally-decidable only by the
   attach-time arena reservation (`05` §1), which turns "is there room?" into
   a fact rather than a forecast. Advisory counters inform hints and queries,
   never API-visible success/failure of unreserved capacity.
4. **C4 — Cached truth, not predicted truth.** The client caches host-emitted
   completion facts and answers polls from that cache instantly when the fact
   is known; unknown completion resolves conservatively as not-ready until
   confirmation arrives (propagation-delay cost accepted; lying rejected).
   Prediction operates only inside the runtime (what to push early, when to
   flush, what to prefetch) and never surfaces through an API return value.
5. **C5 — Failure maps onto native semantics.** Every Vectant failure mode must
   surface as an error code applications *already* handle (e.g.,
   `cudaErrorDeviceLost`, `DXGI_ERROR_DEVICE_REMOVED`). No new failure model is
   allowed to leak to the application.
6. **C6 — The API is the contract, the wire is ours.** Applications keep stock
   CUDA/DX/Vulkan; nothing about the transport is observable except performance.

---

## 1. Top-Level Decomposition

```text
┌───────────────────────────── USER MACHINE (unmodified) ─────────────────────────────┐
│                                                                                     │
│  Application(s): PyTorch, Blender, Unreal, game …                                   │
│        │  stock calls                                                               │
│        ▼                                                                            │
│  ┌── Vectant Client Runtime (user-mode, per-API frontends) ──────────────────────┐  │
│  │  cuda-frontend      vulkan-frontend      d3d12-frontend       gl-frontend     │  │
│  │  (nvcuda.dll shim)  (ICD manifest)       (UMD/proxy chain)    (deferred)       │  │
│  │        └───────────────────┬──────────────────┘                               │  │
│  │                            ▼                                                  │  │
│  │  Core: Command Recorder · Resource Ledger · Placement Engine ·                │  │
│  │        Status Oracle · Batch Scheduler · Command Journal                        │  │
│  │                            │                                                  │  │
│  │                            ▼                                                  │  │
│  │  Transport Fabric (QUIC streams now · WebRTC DC bootstrap · RDMA later)       │  │
│  └────────────────────────────┬──────────────────────────────────────────────────┘  │
└───────────────────────────────│──────────────────────────────────────────────────────┘
                                ║  direct client ⇄ host (control plane NOT proxied)
                                ▼
┌───────────────────────────── VECTANT HOST ──────────────────────────────────────────┐
│  vectant-hostd                                                                      │
│    Session Manager · Auth (mTLS + tokens) · Tenant Sandbox                          │
│    Device Server (per session):                                                     │
│      Command Replayer → native driver (CUDA/HIP/DX/VK)                              │
│      Memory Registry (session handles ⇄ device pointers)                            │
│      Completion Engine → status vector broadcast · predictive result push           │
│      Checkpoint/Fencing (epochs, snapshots)                                         │
│    Metering · Health · VRAM scrub on release                                        │
│              │                                                                      │
│              ▼                                                                      │
│  Physical GPU (exclusive per session in Phase 1)                                    │
└──────────────────────────────────────────────────────────────────────────────────────┘

Control Plane (separate, never in hot path):
  vectant control API — authn/z, discovery, pricing, reservation, routing score,
  attach handshake brokering (WebRTC/ICE credentials, QUIC certs), billing,
  session lifecycle, health, teardown. Built on repo's existing signaling-server
  pattern (ws://…:9000) extended with lease + attestation messages.
```

Component ownership rule: **control plane decides who talks to what**; after
attach, data plane traffic flows directly client⇄host. The control plane may
re-enter only for lifecycle events (renewal, revoke, health polls out-of-band).

---

## 2. Control Plane

Reuse the repository's proven pieces: the signaling server (WebSocket, session
registry, offer/answer relay) becomes the **Attach Broker**. New responsibilities:

| Capability | Notes |
|---|---|
| Catalog + scoring | Hosts publish GPU model, VRAM, region, measured RTT/bandwidth probes, load. Routing score = f(compat, latency, bandwidth, price, reliability) — doc §Routing in concept file. |
| Lease service | Exclusive-GPU leases (Phase 1). Lease = signed token {user, host, gpu-id, window, caps}. Data plane authenticates with it; renewal is automatic; expiry triggers graceful drain. |
| Attach handshake | Broker introduces client⇄host (ICE candidates / host QUIC endpoint + cert fingerprint). After introduction it steps aside. |
| Attestation (later) | Host publishes measured-boot + driver-version claims; clients can demand minimum attestation for sensitive workloads. |
| Ledger | Usage metering reported by host, countersigned by client epoch summaries; billing offline from ledger. |

Design constraints carried from this repo's mandates: auditability is a product
— every lease grant, attach, revocation, and metering event is an immutable,
signed event-log entry; mediated control only (no opaque P2P beyond the
introduced data channel).

---

## 3. Client Runtime (the hardest component)

### 3.1 Frontends (per API)

One frontend per supported API surface; each implements the *same core*
contract ("record, place, submit, observe"). See `02-api-compat.md` for the
full surface analysis; summary:

- **CUDA frontend**: replaces `nvcuda.dll` (driver API chokepoint; cudart and
  all closed-source math libs ultimately call its exports — dependency-chain
  evidence in `02` §A). Reports the *rented* device truth (SM count, VRAM,
  clocks) — never fabricated numbers.
- **Vulkan frontend**: installed as a proper ICD via registry/manifest;
  enumerated as a real adapter. Recording stays local; submits cross the wire
  (`vkQueueSubmit` payload = serialized command buffers).
- **D3D12 frontend (Tier 2+)**: user-mode shim chain on d3d12.dll/DXGI with
  hybrid-present strategy (compute remote; present/composition local —
  cross-adapter present is a native Windows capability used by hybrid laptops).
  Long-term Windows alternative per `01` insight #1 and `02` §C: project the
  WDDM/D3DKMT IOCTL surface (the seam Microsoft itself uses for WSL) rather
  than hooking user DLLs — more stable across OS builds, but higher tier.
- **OpenGL**: deferred; verdict in `02-api-compat.md`.

Frontends are strictly translation layers: parse → core IR → serialize. No
per-app knowledge, ever (hardcoding mandate).

### 3.2 Core services (shared by all frontends)

Shared-services principle (v0.2): frontends share transport, resource
identity, lease/auth, telemetry, bulk transfer, and completion machinery —
they are NOT forced into one lowest-common-denominator GPU command IR. Each
API frontend serializes in its own dialect; premature unification would
flatten API-specific semantics that matter.

1. **Command Recorder(s)** — per-API serializers producing a compact typed
   record stream referencing session-scoped resource IDs for streams/events/
   modules/graphs, and REAL remote GPU virtual addresses for memory (`05`
   §0). Highly compressible (same kernel + layout repeated ⇒ dictionary +
   delta encoding, see `03`).
2. **Resource Ledger** — local bookkeeping of allocations, sizes, residency
   classes, dirty regions, dependency epochs; plus the arena suballocator
   that makes allocation success locally factual (`05` §1). Answers advisory
   queries locally; never manufactures API-visible success.
3. **Placement Engine** *(proposed)* — transport-aware bulk policy.
   Classifies each allocation by predicted access pattern (static weights,
   per-frame uniforms, streaming textures, staging scratch) to govern how/when
   bytes cross the wire and where staging lives. Misclassification is
   recoverable at sync boundaries; it never changes what the app is told.
   Details + failure modes in `05` §6, decision inputs in `03`.
4. **Status Oracle** — maintains last-confirmed host state from the status
   vector; answers polls instantly when the fact is known, not-ready when it
   isn't (`05` §2). No speculation of any kind.
5. **Batch Scheduler** — flush law: flush when `bytes > B_max`, or
   `oldest_record_age > α·RTT_smoothed`, or an explicit synchronization point
   is reached, or a status-critical record needs prioritization. Priority
   lanes: (p0) sync-critical + status vector; (p1) interactive commands;
   (p2) bulk uploads/downloads. Bulk never head-of-line blocks p0/p1
   (independent QUIC streams).
6. **Command Journal** — retransmission buffer of unacked records carrying
   monotonic command IDs. Exactly-once execution is guaranteed by host-side
   deduplication BEFORE GPU execution (`05` §4); the journal enables fast
   resend across transport loss. It does not replay onto fresh hosts.

### 3.3 Client integration ladder (invasiveness tiers)

| Tier | Mechanism | Unlocks | Cost/Risk |
|---|---|---|---|
| T0 | Per-user DLL placement / DLL-redirection for nvcuda.dll + Vulkan ICD manifest | torch/CUDA + headless Vulkan compute | None (no admin, no injection) |
| T1 | Installed service + machine-wide shim registration | All processes, cleaner UX | Anticheat/AppContainer friction |
| T2 | Hybrid-present D3D12 path | Interactive graphics apps | Composition complexity |
| T3 | Kernel virtual adapter (WDDM para-virtual miniport forwarding DDIs to the wire) | Full OS device: DXGI enumeration, DWM, DXVA, games | Driver signing, PatchGuard-adjacent care, highest effort |

Phase 1 = T0 only. T3 is the long-term "feels like hardware" endgame and is
modeled in `08-roadmap-milestones.md`.

---

## 4. Data Plane

Transport evolution: **custom QUIC as the primary data-plane transport**
(own framing per `09`, BBR-family congestion control, priority streams,
0-RTT resumption — chosen for user-space deployability, HOL immunity, and
reconnect speed; decision rationale in `03` §2). **WebRTC data channels are
the bootstrap/fallback** (this repo already operates a signaling server and
WebRTC workers; instant NAT traversal + DTLS maturity), with migration to
native QUIC once profiles exist. **RDMA/RoCE** becomes a pro-host option in
later phases. Multipath (FTTH+5G bonding) is the Phase 2/3 consumer tail-
latency lever. Rationale and numbers: `03-data-plane-design-space.md`.

Stream topology (single connection):

```text
s0 control/keepalive (tiny, highest priority)
s1 status vector (host→client, continuous, RELIABLE — confirmations never silently dropped; see 09 §5)
s2 command stream (client→host, reliable ordered within stream-set)
s3..sn bulk transfer pools (uploads/downloads, parallel, preemptable)
```

Framing: binary TLV; opcode dictionary negotiated at attach; records average
tens of bytes steady-state (kernel-id + param-block-ref + epoch). Compression
policy per content class (never recompress BCn/ASTC; entropy-code weights;
skip already-compressed blobs).

---

## 5. Host Architecture

`vectant-hostd` (Linux, containers; mirrors this repo's GPU-worker pattern):

- **Session Manager**: lease validation, mTLS termination, sandbox spawn
  (one container per session; cgroup/seccomp; no cross-session visibility),
  VRAM pre-scrub + post-scrub verification.
- **Device Server** (per session): holds one native context (e.g., CUDA
  primary ctx) for the tenant; replays command records onto real driver calls;
  maintains Memory Registry (session-handle ⇄ device-pointer map);
  Completion Engine publishes status vectors every ~RTT/2 and performs
  **Predictive Readback** — proactively pushes small results with recent D2H
  history so blocking reads find data in flight (`05` §PR).
- **Completion/Fencing**: EXECUTED-watermark acknowledgements keyed by
  (incarnation, command-id) with host-side dedup before execution (`05` §4);
  optional same-host VRAM checkpoint snapshots (opt-in bandwidth cost) for
  session resume; fence discipline guarantees no cross-epoch reorder of dependent work.
- **Metering/Health**: utilization, VRAM, temperature, ECC events → control
  plane out-of-band.

Multi-tenancy stance: **Phase 1 = one session owns the whole GPU.** Time-sliced
sharing and MIG-style partitioning are later supply-side optimizations
(`07` §multi-tenancy).

---

## 6. Workload Classes and Honest Envelope Claims

| Class | Pattern | Verdict @ 10 ms RTT | Verdict @ 80 ms RTT |
|---|---|---|---|
| LLM inference (server-style) | weights once; forward passes; occasional sampling sync | excellent | good |
| Training step loops | grad sync per step; few CPU reads | very good | good |
| Stable Diffusion / video gen | bursty, few syncs | very good | acceptable |
| Offscreen rendering / encode | frame-batched | good | acceptable |
| DCC viewport (Blender/CAD) | per-frame interaction | marginal-to-good | poor |
| Competitive gaming (240 Hz) | input→frame deadline 4 ms | not viable (be honest) | not viable |

Full derivation: `06-performance-envelope.md`. Product consequence: routing and
UI must *classify the workload up front* and set expectations; the CLI already
shows measured latency — extend with a workload-profile selector.

---

## 7. Why This Hasn't Been Shipped Before (thesis)

1. Everyone attacked **consolidation** (enterprise vGPU: Bitfusion, vGPU) not
   **augmentation** (consumer keeps their machine) — the former tolerates VM/
   relink friction, the latter cannot.
2. Prior systems assumed **LAN/RDMA-class fabrics**, where brute-force
   remotification works; consumer-internet constraints (which force
   speculation, residency engineering, prediction) were never treated as the
   primary design target.
3. API breadth fear drove teams to **SDK retreat** (product gave up
   transparency) — the exact thing the concept doc forbids.
5. Missing enablers until recently: gigabit consumer uplinks, mature QUIC/WebRTC
   transports, and — decisively — **AI workloads**, the first class that is
   simultaneously hour-valuable *and* WAN-tolerant (low sync-rate, huge
   arithmetic intensity). The workload mix moved under everyone's feet.
6. Refinement from `01` forensics: the *narrow* claim "remote CUDA over a
   fast LAN for unmodified apps" HAS been demonstrated repeatedly (rCUDA,
   Bitfusion) and recently even consumer-graded at small scale (LUPINE).
   What has never been built is the whole: WAN-tolerant performance
   engineering + native OS attachment on the user's own machine +
   multi-provider commerce. Vectant's novelty is the composition, and it
   must not re-litigate the solved parts.

Detailed forensics with citations: `01-prior-art.md`.

---

## 8. Open Questions Carried Forward

- Local + remote GPU coexistence (shim exposing local NVIDIA device 0 +
  Vectant device 1 with correct per-backend routing) — Phase 2 milestone,
  explicitly out of Phase 1 scope (`08`).
- D3D12 swapchain interception legality/stability across Windows builds — `02`;
  WDDM/D3DKMT IOCTL projection as its own later program, not a frontend variant.
- Host-side DX12/VK execution implies Windows GPU hosts eventually; Phase 1
  restricts hosts to Linux+NVIDIA (CUDA) to bound scope.
- Multipath bonding as default consumer transport — `03`.
- Warm-pool VRAM snapshots between tenants: privacy analysis — `07`.
- Callback-heavy workloads: quantify the WAN boundary cost from traces
  before promising any mitigation (`05` §3, honest-physics stance).
