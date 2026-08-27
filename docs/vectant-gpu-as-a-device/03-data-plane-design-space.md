# Design Space: Transport, Remote Memory, Synchronization — with Performance Envelope Math

*Vectant architecture analysis · constraints from `vectant_gpu_as_a_device.md`: local app, remote GPU, persistent remote state, aggressive command batching, minimal round trips, direct client↔host data plane, ~8.1 ms regional latency example.*

---

## 1. Performance Envelope

Everything in this document derives from one fact: **the wire replaces PCIe, and the wire is 3–5 orders of magnitude worse at both latency and bandwidth.** Quantify first, design second.

### 1.1 Latency arithmetic

| Path | One-way | Round trip | Notes |
|---|---|---|---|
| PCIe Gen4 x16 MMIO write (posted) | ~0.1–0.2 µs | n/a (fire-and-forget) | doorbell writes are posted; no ACK |
| PCIe Gen4/Gen5 read RTT (e.g., DMA completion read, BAR read) | — | ~1–2 µs | uncached reads traverse the switch hierarchy |
| Kernel launch (HW queue, local) | — | ~2.5–5 µs enqueue→start ([NVIDIA forum measurements](https://forums.developer.nvidia.com/t/launch-of-many-small-kernels-10x-slower-compared-to-one-kernel/350194)) | WDDM adds more than Linux/TCC |
| FTTH intra-city | — | **2–10 ms** | Vectant's 8.1 ms example sits here |
| Cross-EU (e.g., Berlin↔Dublin) | — | **8–25 ms** | |
| Transatlantic (NY↔London fiber) | — | **70–110 ms** | speed-of-light-in-glass floor ≈ 28 ms one-way plus routing |
| 5G (SA, good signal) | — | **30–60 ms** | radio scheduler dominates |

The ratio that matters: a **doorbell-style posted write** goes from ~150 ns to one-way wire delay (half an RTT if you need confirmation), and a **round-trip-consistent operation** goes from ~1–2 µs to 2–110 ms — a degradation factor of:

```
10 ms / 1.5 µs   ≈  6,700×   (intra-city FTTH)
25 ms / 1.5 µs   ≈ 17,000×   (cross-EU)
100 ms / 1.5 µs  ≈ 67,000×   (transatlantic)
```

Even against the *slowest* plausible local CPU↔GPU interaction (a synchronous kernel launch + result read, ~10 µs end-to-end), a 10 ms WAN is 1,000× slower. Conclusion: **any protocol that preserves per-operation request/response semantics is dead on arrival.** The system must behave like a device with an enormous internal FIFO, not like a memory bus.

### 1.2 Bandwidth arithmetic

| Link | Sustained | In Gbps |
|---|---|---|
| PCIe Gen4 x16 | 32 GB/s | 256 |
| PCIe Gen5 x16 | 64 GB/s | 512 |
| Consumer 1 Gbps FTTH uplink (often 0.5–1 Gbps real) | 0.12 GB/s | 1 |
| Consumer 10 Gbps uplink | 1.2 GB/s | 10 |

The gap: **256 Gbps ÷ (1–10 Gbps) = 26×–256× link-level**, and after QUIC+TLS overhead (~3–5%) and header costs, usable goodput makes the practical gap **≈30×–300×**. What this forbids, concretely:

- **Transparent unified/pinned-memory semantics.** CUDA unified memory migrates pages on fault at NVMe/PCIe speeds; over a 1 Gbps WAN a single 2 MB page takes ~16 ms (vs ~50 µs local NVMe, ~60 µs PCIe). Page-granularity transparency is arithmetically impossible at 4K granularity: 4 KB over 10 ms RTT = 0.4 MB/s per outstanding fault without deep pipelining.
- **Per-frame full-surface readback.** A 4K framebuffer (3840×2160×4 B ≈ 33 MB) at 1 Gbps uplink = ~265 ms/frame. Readbacks must be small, sparse, or never.
- **Full-VRAM checkpoint/restore inside interactive timescales.** 32 GB VRAM at 1 Gbps ≈ 4.7 min one way. Session attach/detach, tenant moves, and failover designs must assume *state lives remote and stays there*, or accept minutes-long migrations.
- **Naïve texture streaming of uncompressed assets.** 100 MB of BC7-decoded surface per second exceeds most uplinks; only compressed-on-disk formats can cross the wire.

### 1.3 Sync-budget rules

Define `S` = number of **unavoidable blocking round trips** per period, `RTT` = wire round trip, `B` = period budget.

- **Per 16.6 ms frame:** hard law: `S × RTT + GPU_exec ≤ 16.6 ms`. At RTT = 10 ms, **S ≤ 1** — and even one sync consumes >60% of budget, so it must be issued early in frame N−1 and consumed in frame N (pipelined), never inline. At RTT ≥ 17 ms, **S = 0**: the design must guarantee no frame ever blocks on the wire, which forces a ≥2-frame-deep pipeline and speculative input handling. At 70–110 ms, no per-frame-coupled design survives at all; the workload must be restructured (see §4, Split-Present).
- **Per training step:** target `S × RTT ≤ 0.1 × T_step`. Small-batch fine-tuning with T_step = 20 ms tolerates zero blocking syncs at 10 ms (one sync alone = 50% overhead); large-batch training with T_step = 500 ms tolerates ~5. Practical corollary: **step time, not FLOPs, decides viability** — anything below ~200 ms/step at 10 ms RTT must be made sync-free via async pipelines (`cudaMemcpyAsync`, event-based overlap) which conveniently is how well-written training code already works.
- **General rule:** every API surface must be classified by whether it can be deferred past its observable effect. That classification is §4.

### 1.4 Op-class tolerance

| Op class | Size/frequency | Wire cost at 10 ms RTT | Verdict |
|---|---|---|---|
| Bulk H2D once (model weights, scene) | GB, once | seconds, amortized | ✅ Fine — pipeline with progress |
| Kernel-launch bursts | 100 s–1000 s/step, ~KB each | fatal unbatched (each = 1 RTT if acked) | ✅ if batched into command streams/graph replays |
| Tiny D2H reads (scalar result, `.item()`, loss value) | bytes, frequent | 10 ms each, unhideable | ⚠️ Only at loop granularity; batch/coalesce |
| Event/query results feeding branching | bytes, per-frame | same | ⚠️ Speculate or restructure (§4.3) |
| Texture streaming | MB–GB, steady | uplink-bound | ⚠️ Compressed formats only; delta updates |
| Present/frame push | small, per frame | fits if fire-and-forget | ✅ posted, no ACK |

### 1.5 Workload archetype × dominant pattern × verdict at 10 ms RTT

| Archetype | Dominant pattern | Blocking-sync count | Verdict @10 ms |
|---|---|---|---|
| LLM inference (decode, small batch) | thousands of tiny kernels, launch-bound | ~0 if graphed | ✅ Viable; TTFT unaffected, per-token adds ~0 if pipelined, but CPU-side polling loops must be defused |
| LLM/batch training | weights once, coarse steps, rare scalars back | 1–3/step | ✅ Good when T_step > 200 ms |
| Stable-diffusion-class generation | few large kernels, one final D2H | 1/job | ✅ Excellent |
| Classical ML (XGBoost, small-tensor loops) | many tiny ops, eager sync | 10–1000/step | ❌ Poor — needs graph capture or stays local |
| Blender viewport / DCC | per-frame dep chain + occasional readback (sculpt, pick) | 1–5/frame | ⚠️ Marginal — needs Split-Present + readback discipline |
| Unreal/Unity editor | per-frame fences, asset streaming, PIE sync | >1/frame | ⚠️ Hard — partial hybrid only |
| Real-time games | 16.6 ms deadline, per-frame fences, input-coupled | ≥1/frame inline | ❌ Remote-compute-only fails; needs §5 Split-Present |
| Video encode/transcode | upload once, long encode, streamed output | ~0 | ✅ Good (output bitrate must fit uplink) |
| Scientific compute (long kernels, big arrays) | hours of compute, occasional reduction | ~0 | ✅ Excellent |

---

## 2. Transport

### 2.1 Candidate comparison

| Candidate | Latency profile | Loss behavior | Fit |
|---|---|---|---|
| **TCP (kernel stack)** | 1 RTT connect (+1 TLS), HOL blocking across all commands; head-of-line stall = lost-PKT-delay for a whole batch | retransmit, bufferbloat-prone | Baseline only. A lost segment stalls *all* streams; unacceptable when mixing 64-byte doorbells with 8 MB uploads |
| **QUIC (user space)** | 1-RTT handshake, **0-RTT resumption** ([Springer, J. Cryptology 2021](https://link.springer.com/article/10.1007/s00145-021-09389-w)); per-stream ordering kills cross-stream HOL | per-stream loss recovery; lossy-network wins shown in [RWTH measurement study](https://www.comsys.rwth-aachen.de/publication/2019/2019_wolsing_a-performance-perspective-on/2019_wolsing_a-performance-perspective-on.pdf) and [Dissecting Production QUIC, WWW'21](https://dl.acm.org/doi/10.1145/3442381.3450103) | **Right default.** User-space = we own pacing, priorities, schedulers without kernel work; streams map naturally to command classes |
| **Custom UDP + FEC** | sub-RTT repair (no retransmit wait) | XOR/Reed-Solomon parity recovers bursts | Later optimization for sync-critical lane; complexity high, win concentrated in lossy access networks (5G) |
| **RDMA / RoCEv2 / iWARP** | low single-digit µs kernel-bypass ([RoCE vs iWARP](https://intelligentvisibility.com/rdma-roce-iwarp-guide)) | requires lossless fabric (PFC/ECN) for RoCE; iWARP more loss-tolerant but heavier | Only when **both ends have it**: datacenter-hosted GPUs with Ethernet NICs vs consumer FTTH CPE — almost never true at the client. Keep as *optional fast path* for prosumer/hosted-client scenarios ([rCUDA](https://network.nvidia.com/pdf/whitepapers/rCUDA_Middleware_and_Applications.pdf) demonstrates IB-RDMA module pattern) |
| **Multipath MPTCP / Multipath-QUIC link aggregation** | aggregate N access links (FTTH + 5G); per-path failover hides route flips | path skew handled by scheduler | **High-leverage novelty**: consumers routinely have 2 links; bonding them multiplies both scarce uplink and resilience. MP-QUIC preferred (user-space, 0-RTT, matches main stack) |

### 2.2 Host/client-side kernel bypass

The HOST side is a controlled datacenter box: **DPDK or XDP** for the UDP fast path, `io_uring` with registered buffers + zero-copy send (`IORING_OP_SEND_ZC`) for the QUIC user-space stack — removes syscall and copy overhead where we control the machines. The CLIENT side is untrusted consumer Windows: assume stock kernel networking, user-space QUIC, and spend effort on **zero-copy from application buffers into the NIC** where possible (registered IO / RIO APIs, `WSASendMsg` with `MSG_…` fast paths), not on requiring drivers. Asymmetric investment: heavy machinery server-side, graceful degradation client-side.

### 2.3 TLS realities

AES-GCM with AES-NI/VAES costs ~<1 µs per 16 KB record on modern CPUs — negligible next to any wire RTT; encryption is **not** the bottleneck, do not skip it. Use TLS1.3/QUIC **resumption + 0-RTT** for reconnects (sleep/wake, host migration): saves a full RTT exactly when a session resumes and users notice. Caveats: 0-RTT data is replayable → only ever carry **idempotent** commands in 0-RTT (command streams are naturally idempotent if tagged with epochs; see §5.2). Key updates (QUIC key phase) must not stall the pipeline — rotate lazily.

### 2.4 Congestion control

The traffic mix is hostile: microsecond-scale command bursts + multi-minute bulk uploads sharing one pipe. CUBIC reacts to the first dropped packet by collapsing cwnd — deadly for burst-heavy mixes ([Production QUIC study shows CC choice dominating outcomes](https://dl.acm.org/doi/10.1145/3442381.3450103)). Choose **BBRv2/BBRv3**: model-based, tolerates early loss without window collapse, handles bursty app-limited traffic far better. Tune: raised initial cwnd for resumption, pacing on, no slow-start-after-idle. Reserve raw rate for the sync lane (§2.5) so bulk uploads cannot starve doorbells.

### 2.5 Message scheduling

- **Strict priority lanes** (mapped to QUIC streams): P0 = sync-critical (fence signals, query answers, heartbeat), P1 = command records, P2 = control (allocations, residency), P3 = bulk data. P0 preempts P3 mid-upload (stream-level pause).
- **Coalescing timer, Nagle-kill:** never let the stack batch-by-time what the app didn't ask to batch; our batching policy lives in ONE place (the §4.5 flush law). Set `TCP_NODELAY`-equivalent everywhere; QUIC implementations vary — enforce packet-flush on P0/P1 immediately.
- **Single pipe vs per-stream:** one connection (shared CC, shared loss state = honest view of the access link), many streams (independent ordering). Never multiple connections: they fight each other in the bufferbloat regime.
- **Header compression for command records:** command streams are extremely redundant (same opcodes, same handle prefixes, monotonically increasing epochs). A per-session dictionary + varint/prefix coding gets command records from ~48–96 B to ~6–20 B. This matters less for bandwidth than for **packet count** — small packets are what trigger per-packet processing costs and ACK pressure.
- **Compression by content class:** BCn/ASTC textures: **never recompress** (already entropy-coded; LZHSDC costs CPU and shrinks nothing). fp16/bf16 weights & activations: **entropy coding wins** (zstd-level or bitplane schemes typically get 5–15% on trained weights; more importantly enable §5.6 delta-sync). Vertex/index streams: **delta + quantization** against previous version wins hugely on edited meshes. Generic buffers: try zstd, fall back per-allocation based on measured ratio (first-MB sample).

### 2.6 Phased transport evolution

1. **Phase 1 (now):** user-space QUIC (e.g., quiche/msquic/ngtcp2), BBR-family CC, priority streams, 0-RTT resume, command-record dictionary coding. Works over any consumer network; zero special privileges.
2. **Phase 2:** FEC-augmented sync lane (custom small-packet path alongside QUIC for P0), io_uring/DPDK host-side tuning, per-link telemetry.
3. **Phase 3 (novelty):** multipath aggregation (MP-QUIC) bonding FTTH+5G; optional RDMA fast path auto-detected when both ends advertise it (hosted clients, EU metro fiber).

---

## 3. Remote Memory Subsystem

### 3.1 Architecture candidates

**(a) Remote-authoritative VRAM + optional local staging cache.** Allocations live in remote VRAM; the client holds metadata + optionally a read-only staging copy. Uploads are pushed once; downloads are pulled explicitly. *Pros:* matches the doc's "keep state remote" principle; no coherence machinery; failure semantics simple (session death loses nothing the user has locally). *Cons:* every CPU-side touch of GPU memory contents becomes a network op; demands the sync disciplines of §4.

**(b) Local shadow + dirty tracking via page protection.** Mirror allocations locally; catch CPU writes with `VirtualProtect(PAGE_NOACCESS)`/guard pages + **vectored exception handler** (VEH), mark dirty, propagate. Feasibility assessment for Windows:
- Mechanism is standard (guard pages raise `STATUS_GUARD_PAGE_VIOLATION`, handled via VEH — [MSDN memory-protection constants](https://learn.microsoft.com/en-us/windows/win32/memory/memory-protection-constants), [VEH usage pattern](https://reversing.codes/posts/Detecting-injected-code-with-page-guards/)).
- Granularity is locked to the OS page (4 KB x64; Windows may use 64 K allocation granularity for mappings) — finer tracking impossible without compiler instrumentation.
- Cost per fault: `VirtualProtect` pair + exception dispatch ≈ **1–2 µs+/fault**; a first-touch scan of a 1 GB buffer at 4 KB granularity = 260 K faults ≈ 0.3–0.5 s of pure overhead, plus VEH contention across threads.
- **Thrash risk:** pointer-chasing workloads (CPU walks a GPU-resident structure) generate faults forever — protection-based schemes collapse. Usable only for *write-mostly, scan-shaped* regions (staging buffers, per-frame uniform rings), where you protect once per frame and get clean dirty sets.
- Verdict: **niche tool**, not the backbone. Use for uniform/ring buffers and for cheap dirty-set discovery on staging memory; never for randomly-accessed device heaps.

**(c) Demand paging over WAN (Infiniswap/Leap lineage).** [Infiniswap](https://infiniswap.github.io) showed RDMA-fabric remote-memory paging with decentralized chunk placement; [Leap](https://github.com/SymbioticLab/Leap) adds online majority-based prefetching, improving median remote-page latency up to ~104× over a naive path and app performance up to ~10× over prior art. Their numbers are RDMA-LAN (µs-class faults). Over a 10 ms WAN the same design shifts feasibility by ~3 orders of magnitude: a 4 KB fault at 10 ms RTT is catastrophic unpipelined, so a WAN paging layer must (i) use **large pages/chunks (2–64 MB)** to amortize, (ii) keep dozens-hundreds of fetches in flight, (iii) treat the first touch as a prefetch problem, not a fault problem. Comparison anchor: local NVMe fault service ~50–100 µs vs WAN chunk service 10 ms+ — **WAN paging is 100–200× worse than disk**, i.e., only viable above a working-set cliff nobody should hit by design. It's the safety net, not the strategy.

### 3.2 Eviction + prefetch mined from API-call sequences

The client sees the full API stream (allocations, binds, copies, launches) — richer signal than OS page stats. Build a per-resource Markov/replay predictor: sequence model over (resource_id, op, epoch) predicting next-touch distance; evict LRU-except-predicted-soon from any local staging cache; prefetch resources whose predicted time-to-touch < RTT + fetch time. Replay predictors shine for iterative apps (trainers, viewport with stable camera paths) — the same reason Leap's majority-based prefetching works. Failure mode: phase changes (editor → PIE play) invalidate the model; detect via prediction-error spike and fall back to conservative LRU within a guard band.

### 3.3 Spill hierarchy

`remote VRAM (authoritative) → host RAM beside the GPU (host-service staging, fast NVMe-backed) → OOM`. Semantics matter: allocation failure must look like **device-OOM to the app** (CUDA: `cudaErrorMemoryAllocation`; DX12: `E_OUTOFMEMORY`) rather than stalling invisibly on wire-bound eviction. Rule: never evict to the point where a *pending* command references absent state; residency is promised at submit-time (command streams reference-check before flush).

### 3.4 Transport-aware allocator [PROPOSED]

A placement engine that classifies each allocation by **predicted access pattern** and chooses: remote-authoritative / staged-local / split / compressed-transit. Decision inputs:

- size & lifetime hint from API context;
- observed access shape: write-once-read-many (weights), streaming sequential (textures, video), tiny-hot-ring (per-frame uniforms), random CPU-touched (readback buffers), peer-copied (intermediate activations);
- measured per-shape wire economics at current RTT/bandwidth (live feedback);
- app-declared hints when available (CUDA `cudaMallocManaged` advise, DX12 heap flags).

Failure modes (must be handled, not wished away): misclassification thrash (flip-flopping placements — dampen with hysteresis + minimum residence time); phase changes (§3.2 detector); pointer-identity assumptions (apps compare device pointers across allocations — placement must never change a live allocation's address; migrate only at alloc boundaries or via explicit API-visible events); and pathological mixed access (a buffer that is both hot-random-CPU and hot-GPU — classify by *cost of being wrong*, prefer remote + explicit staging copies). This allocator is the highest-leverage memory decision because it converts a global architecture argument (a vs b above) into a per-allocation economic choice.

### 3.5 Compression-at-rest-in-transit + dedup

Weights/activations: zstd-19-class offline dictionaries per content family (trained once, reused across sessions) — cuts upload volume 5–15% at line speed with AES. **Dedup for repeated uploads:** hash chunk-wise (64–128 KB rolling hash) at the client; repeated uploads of unchanged chunks (checkpoint reload, level restarts, iteration in a DCC tool) transfer only hashes — the host keeps a content-addressed cache per session. Checkpoint-reload workloads commonly see 80–99% dedup hits. Security note: chunk hashes leak content equality only; acceptable within one authenticated session.

---

## 4. Synchronization Semantics

This is the core invention area. The organizing question: **for each primitive, what happens between "app issued it" and "host actually executed it," and can we answer the app early?**

### 4.1 Taxonomy by speculation safety

**NEVER speculate (result feeds a CPU decision that has side effects):**
- `cudaMemcpy` D2H whose destination the CPU immediately branches on (control flow, file writes, UI);
- malloc/allocation results (failure paths change program behavior);
- query results used for adaptive algorithms (occlusion queries driving draw submission, timing queries driving LOD selection) *when the branch is irreversible*.

Why never: rollback of CPU-side side effects is impossible. If we answer "event complete" optimistically and the app then writes files/sends packets/spawns processes based on it, no reconciliation undoes it. Divergence between predicted and actual state is unbounded.

**ALWAYS-safe deferral (acknowledgement carries no information the app consumes synchronously):**
- event record, kernel launch enqueues, stream-op submits, free/destroy enqueues, attribute sets. These become **posted commands**: assign monotonic sequence numbers, flush per the batching law, and synthesize success locally. Errors surface later as stream-state poisoning (exactly like CUDA's async error model — apps already tolerate late error surfacing here).

**[SUPERSEDED v0.2 — no API-visible speculation of any kind.]**
The v0.1 draft proposed "optimistic-true with correction callbacks" for
polling loops and fence waits. Rejected: an application can perform
irreversible CPU side effects the moment a poll returns true — free
resources, send packets, mutate state — and no callback can reverse them.
Normative rule now (`04` Superseding Rule, `05` §2):

> API-visible completion is reported ONLY from host-confirmed facts.
> Unknown completion resolves as not-ready until confirmation arrives.

Polling loops still become local: the client answers from its cache of
received confirmations (instant when known, conservative when not). The cost
is propagation-delay completion latency; the alternative is lying to programs
that branch on the answer. Prediction survives ONLY inside the runtime:
deciding what to prefetch, when to flush batches, what PR should push early.

### 4.2 Heartbeat-batched status vectors

Instead of per-query responses, the host pushes a periodic (every min(α·RTT, 5 ms)) **status vector**: bitmap of all outstanding events/fences/queries with their states. Amortizes query traffic to near-zero; gives the client fresh-enough truth to run §4.1 speculation with tight bounds. Vector deltas are tiny (dictionary-coded handles + 2-bit states). This turns "thousands of sync objects" from thousands of potential RTTs into one multiplexed stream — the single biggest constant-factor win in the sync plane.

### 4.3 Adaptive batching law

Flush the command stream when ANY of:
1. `bytes_buffered > B_max` (throughput guard; e.g., 256 KB),
2. `oldest_cmd_age > α · smoothed_RTT` (latency guard),
3. explicit sync/event-wait boundary (correctness),
4. stream-switch or dependency hazard (correctness).

Alpha analysis: α too small (0.1) → packets per command approach 1, per-packet overhead and ACK pressure dominate; throughput collapses for bursty callers. α too large (5+) → oldest command waits 5 RTTs; latency-sensitive sequences (input → render submit) inflate by that factor. The Pareto knee sits at **α ≈ 0.25–0.5**: flush cost ≈ half an RTT of added age in the worst case while still aggregating bursts arriving within a quarter-RTT window (empirically most launch bursts arrive in <1 ms clumps). Make α adaptive per stream class: start 0.33, tune by measuring `(flushes/sec × bytes/flush)` vs `p99 command age` online — a two-objective bandit with correctness constraint #3/#4 held fixed.

### 4.4 CUDA graphs → wire sessions

CUDA Graphs are already a **pre-serialized, topologically sorted command bundle** — exactly what a wire protocol wants. Map: graph instantiate → upload once as a replay template (handle on host side); graph launch → single small command ("replay h123 with param-block p") instead of N serialized node commands. For iterative apps this converts per-step command traffic from kilobytes-to-megabytes into ~tens of bytes, eliminating the launch-burst class entirely (graphs deliver 1.5–3× locally precisely by killing per-kernel overhead — [PyTorch/CUDA Graphs](https://pytorch.org/blog/accelerating-pytorch-with-cuda-graphs), [quantified benefits](https://docs.nvidia.com/dl-cuda-graph/cuda-graph-basics/quantitative-benefits.html)). On the wire the multiplier is larger still: one packet replaces thousands. Client driver should *aggressively auto-capture* stream patterns into implicit graphs (capture on detected repetition) since apps won't opt in. Update semantics (`cudaGraphExecUpdate`) map to template patch commands. Same trick applies to Vulkan/DX12 command lists + fence bundles: they're natively bundle-shaped.

### 4.5 DX12 fence emulation and CPU-side spinning pitfalls

Apps poll fences with busy-spin (`fence->GetCompletedValue() == target`) or `WaitForSingleObject` with tiny timeouts — hundreds of polls/second. Emulation: maintain a **monotonic completed-value watermark** fed by heartbeats; satisfy spins locally from CONFIRMED watermark facts only (values ≤ last-reported executed watermark; unknown values wait for confirmation — never guessed). Pitfall: CPU spin threads burn cores and hammer the emulated query path — detect spin signatures (poll interval < 1 ms on same object) and put the calling thread on an efficient wait keyed to heartbeat arrival, preserving wake-up latency bounds. `WaitOnFence`-style GPU-side waits translate to remote fence ops in the status vector — never round-trip them.

### 4.6 Stream callbacks / tracked launch completion

Host acknowledges a launch in three stages: received → scheduled → complete, carried in the status vector. Client maps "complete" to API-visible completion. Callbacks (launch-order guarantees) are enforced by sequencing epochs client-side, so callback order is deterministic regardless of wire reordering.

---

## 5. Novel Mechanism Catalog

Ratings: Win = expected performance/architecture payoff; Risk = failure probability × blast radius.

**5.1 Speculative Execution Window [PROPOSED]** — Execute commands ahead of confirmed order within an epoch window; discard-and-replay the window on reorder/injection failures. Win: hides up to 1 RTT of ordering stalls for dependency-safe DAG prefixes; medium-high (turns 2 RTT sequences into 1). Risk: HIGH — divergence semantics are subtle (side-effectful commands must be excluded from windows), and replay storms under instability could make tail latency worse than no speculation. Gate: only for provably pure command runs.

**5.2 Session State-Machine Replication with Idempotent Epochs [PROPOSED]** — *[v0.2 demoted to research-only: GPU work is not idempotent (`counter++`), and a standby host lacks VRAM state — tens-of-GB state shipping takes minutes on consumer links. Exactly-once reconnect is handled by command-ID dedup on the SAME host (`05` §4); cross-host failover stays out of roadmap until replicated GPU state proves economical.]* Every command carries (session_epoch, seq); host applies exactly-once; client can resume onto a warm standby host by replaying the last acked epoch + shipping residual state. Win: host failover in seconds instead of session death; enables the doc's reliability requirements. Risk: MEDIUM — dual-host cost, epoch-discipline bugs manifest as duplicated side effects; mitigated by making all commands idempotent-or-tagged by construction (allocator ops carry allocation intents, not outcomes).

**5.3 Predictive Prefetch from Replay Traces [PROPOSED]** — Per-app/per-phase traces of (allocation, bind, copy) sequences drive prefetch of assets into remote VRAM ahead of first use (§3.2 industrialized: persistent trace store keyed by scene/checkpoint hash). Win: removes first-touch stalls worth seconds on large scenes; compounding with dedup (only missing chunks ship). Risk: LOW-MEDIUM — wrong predictions waste uplink; cap prefetch concurrency and validate by hit-rate telemetry.

**5.4 Transport-Aware Allocator [PROPOSED]** — Per-allocation placement engine driven by predicted access pattern and live wire economics (§3.4). Win: converts the memory architecture from a global bet into per-resource optimization; plausibly the largest single perf lever across heterogeneous workloads. Risk: MEDIUM — misclassification thrash, pointer-identity violations; mitigations specified (hysteresis, address stability, cost-of-being-wrong weighting).

**5.5 Split-Present (remote compute + local raster/display hybrid) [PROPOSED]** — For interactive graphics: run heavy compute/raytracing remotely, ship compact intermediate (tiles/gbuffers/compressed radiance) to a local GPU for raster/display compositing; inverse direction ships gbuffer/depth for remote shading when profitable. Win: unlocks the game/editor archetypes the envelope otherwise forbids — display path never touches the WAN. Risk: MEDIUM-HIGH — needs both GPUs, intermediate bandwidth engineering (a 1080p tile stream at 60 fps ≈ 0.3–1.5 Gbps compressed — fits 10G, marginal on gigabit), and per-engine integration depth varies.

**5.6 Delta-Sync for Iterative Training [PROPOSED]** — Ship only changed slices of gradients/optimizer state between host checkpoints: client computes structural diffs (sparse-update masks, quantized residual moments) against the last acked revision; host reconciles. Win: order-of-magnitude traffic cut for momentum/Adam-style states (which change sparsely at low precision significance); directly attacks the 30–300× bandwidth gap for the flagship AI workloads. Risk: LOW-MEDIUM — numerical reconciliation bugs corrupt training silently; mitigate with checksummed revisions and a fallback full-sync cadence.

**5.7 Client-Side Kernel-Cache [PROPOSED]** — Cubins/SPIRV-DXIL compiled once (client or host), cached BOTH ends keyed by (source hash, arch, driver version, options). Session attach ships cache manifests; hits load instantly. Win: removes shader-compilation stalls from first-run and reattach; huge for games/editors (shader stutter is a top-tier pain point even locally). Risk: LOW — invalidation discipline (driver-version-keyed) is well-understood; storage bounded by LRU.

**5.8 Clock-Domain Free Fencing [PROPOSED]** — All cross-stream ordering uses logical timestamps (Lamport-style per-stream counters merged at dependency points), never wall-clock timeouts; timeouts exist only for liveness alarms. Win: correct-by-construction ordering despite variable RTT/jitter; simplifies failover (epochs + logical clocks = total order). Risk: LOW — standard distributed-systems machinery, applied rigorously.

**5.9 Latency-Directed Reordering within Dependency-Safe DAG [PROPOSED]** — Client analyzes the declared dependency DAG of a flushed batch and reorders sends so that long-running nodes launch first (critical-path-first packing), short independent ops fill gaps. Win: reduces effective makespan per batch by tens of percent for wide graphs; zero semantic change (dependency-preserving). Risk: LOW — bounded by DAG correctness; worst case equals original order.

**5.10 Warm-Pool VRAM Snapshots (COW from previous tenant scrub) [PROPOSED]** — Host maintains scrubbed warm snapshots of common runtime footprints (runtime DLL pools, common engine shader caches); new sessions COW-attach in ms instead of cold-init. Win: slashes attach latency (doc's UX promise: "✓ GPU attached" fast) and improves density. Risk: MEDIUM — tenant isolation is security-critical (snapshot scrubbing must be provably complete — ties into the doc's memory-clearing requirements); audit cost is real.

**5.11 Adaptive Precision Transport [PROPOSED]** — Non-critical channels (debug/telemetry/profiling readbacks, intermediate visualization taps) downshift precision (fp32→bf16/int8) and sample-rate automatically under bandwidth pressure, restoring fidelity when the link recovers. Win: keeps debuggers/profilers usable on thin uplinks instead of stalling them. Risk: LOW-MEDIUM — must never apply to data-bearing compute results (hard allowlist by allocation class; default off for unknown allocations).

**5.12 Heartbeat Status Vectors** (promoted from §4.2 into the catalog for rating) — Win: HIGH, eliminates the query-traffic class; Risk: LOW. Cheapest high-value mechanism in this document; build first.

---

## 6. Top 10 Design Decisions (ranked)

1. **Posted-command semantics everywhere: commands get sequence numbers, never per-command ACKs** — the entire latency arithmetic (§1.1) forbids request/response; everything else builds on this.
2. **Heartbeat-batched status vectors as the only sync-truth channel** — collapses unbounded query traffic into one stream and enables safe speculation; cheapest enormous win (§4.2, §5.12).
3. **Remote-authoritative VRAM with per-allocation placement (Transport-Aware Allocator)** — persistent remote state is the concept's core claim; make placement an economic per-resource decision, not a global bet (§3.1a, §3.4).
4. **QUIC with BBR-family CC, priority streams, 0-RTT resumption as Phase-1 transport** — user-space control, HOL immunity, and reconnect speed with zero client prerequisites (§2.1, §2.4, §2.6).
5. **API-visible truth is host-confirmed only; prediction lives inside the runtime** — no optimistic statuses at all after v0.2 review (a generic app's side effects on early-true are irreversible); speculation boundary moved entirely below the API surface (§4.1).
6. **CUDA-graph/stream-bundle mapping to pre-serialized wire templates with auto-capture** — converts launch bursts (the dominant command pattern) into ~bytes per step (§4.4).
7. **Adaptive flush law with α≈⅓·smoothed_RTT, byte threshold, and correctness-forced boundaries** — batching policy exists in exactly one place; tunable per stream class without protocol changes (§4.3).
8. **Chunk-hash dedup + content-class compression policies baked into the upload path** — repeated uploads dominate real usage (checkpoints, restarts); near-free order-of-magnitude traffic cuts (§3.5, §2.5).
9. **Split-Present as the designated escape hatch for interactive graphics** — accepts the envelope math that full remote rendering fails at ≥10 ms and routes around it (§5.5).
10. **Command-ID dedup-at-host as the exactly-once substrate** — GPU work is NOT idempotent (`counter++` twice ≠ once); exactly-once comes from host-side deduplication BEFORE execution, powering reconnect resume only. Warm-standby failover via epoch replay was dropped in v0.2: new hosts lack VRAM state, and tens-of-GB transfers take minutes on consumer links (`05` §4).

---

## References

- rCUDA middleware & applications (RDMA/TCP modules, remote-GPU overhead data): https://network.nvidia.com/pdf/whitepapers/rCUDA_Middleware_and_Applications.pdf ; https://ieeexplore.ieee.org/document/8744256
- Infiniswap (remote memory paging, RDMA): https://infiniswap.github.io
- Leap (prefetching for disaggregated memory): https://github.com/SymbioticLab/Leap
- CUDA Graphs benefits: https://pytorch.org/blog/accelerating-pytorch-with-cuda-graphs ; https://docs.nvidia.com/dl-cuda-graph/cuda-graph-basics/quantitative-benefits.html
- Kernel-launch overhead figures: https://forums.developer.nvidia.com/t/launch-of-many-small-kernels-10x-slower-compared-to-one-kernel/350194
- QUIC vs TCP+TLS performance: https://link.springer.com/article/10.1007/s00145-021-09389-w ; https://www.comsys.rwth-aachen.de/publication/2019/2019_wolsing_a-performance-perspective-on/2019_wolsing_a-performance-perspective-on.pdf ; https://dl.acm.org/doi/10.1145/3442381.3450103
- RoCE/iWARP characteristics: https://intelligentvisibility.com/rdma-roce-iwarp-guide
- Windows guard pages / VEH: https://learn.microsoft.com/en-us/windows/win32/memory/memory-protection-constants ; https://reversing.codes/posts/Detecting-injected-code-with-page-guards/

Items marked **[PROPOSED]** are original proposals of this analysis WITHOUT a formal novelty/patent search; several have obvious conceptual ancestors in the cited literature (logical clocks, caches, predictive prefetch, status broadcast) — 'proposed' claims only that we have not seen this exact combination shipped, nothing stronger.
