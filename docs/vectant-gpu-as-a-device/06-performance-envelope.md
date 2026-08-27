# Vectant Performance Envelope — The Arithmetic

Status: DRAFT v0.1 (2026-08-23) · Planning only, no code
Purpose: quantify what is and is not achievable, so every design decision in
`04`/`05` traces to numbers, not vibes. All figures order-of-magnitude honest;
constants to be re-measured live during Phase 0.

---

## 1. Latency Arithmetic

### 1.1 Round-trip reference points

| Path | Typical RTT |
|---|---|
| PCIe gen4 doorbell + completion (same box) | ~1–2 µs |
| Same-datacenter IP network | 0.2–1 ms |
| Intra-city FTTH (user↔metro DC) | 2–6 ms |
| Cross-country EU (Frankfurt↔Milan) | 10–20 ms |
| Transatlantic (EU↔US-East) | 70–95 ms |
| 5G (good conditions) | 25–50 ms |

Design consequence: the system must remain *correct* at any RTT but remains
*useful* only for workloads whose sync rate stays below a budget.

### 1.2 Sync budgets

Let S = unavoidable synchronous round trips per unit of work.
Workload survives when `S × RTT ≪ work_time`.

| Workload | Unit | Budget | Max S @10 ms | Max S @80 ms |
|---|---|---|---|---|
| LLM decode, unmodified autoregressive loop, CPU-gated per token | 33 ms/token | ≤10 ms overhead | 1 | **0 — fails budget** (see note A) |
| LLM serving, batched/speculative runtime hiding per-token fetch | amortized | relaxed | several | several |
| LLM prefill / batched serving | 100 ms+ | amortized | several | several |
| Training step (50 ms fwd+bwd), single remote GPU | step | ≤15% ⇒ 7 ms | 0 (grads stay GPU-resident) | 0 |
| Stable Diffusion (20 steps × 300 ms) | image | ≤3 s | ~unbounded-ish | few per image |
| Offscreen render frame (16–60 ms) | frame | ≤5 ms | 0 (pipelined) | 0 pipelined, 1 per shot boundary |
| DCC viewport @60 fps | 16.6 ms | ≤5 ms | 0 (must pipeline) | marginal |
| Competitive game @240 fps | 4.16 ms | ≤1.5 ms | **impossible** | impossible |

**Note A (decode-loop honesty):** an unmodified autoregressive loop that
fetches each token/logits to CPU before deciding the next step has its
latency floored by GPU-finish + one-way propagation, every token. PR can
hide the *request* leg when it predicts what to push, never physics. Only
runtime-level techniques (batched stepping, speculative decoding, graphed
multi-token blocks) change the sync rate itself. Verdict: WAN LLM decode UX
is tier-dependent and must be measured per runtime, not assumed.

The punchline table: **AI-era workloads tolerate 1–few syncs per work unit;
interactive graphics tolerates zero; nothing survives competitive gaming.**
This matches §6 of the architecture doc and dictates product sequencing.

### 1.3 Where Vectant spends its sync budget

Per logical batch: exactly one true RTT is unavoidable when the CPU must
consume GPU state before proceeding (blocking readback, hard stream sync).
Status Vector + confirmed-truth polling removes query traffic entirely.
Predictive Readback hides the request/response leg of repeatable reads ONLY
when the pushed result arrives before the CPU demands it — the floor remains
GPU-finish + one-way propagation (see Note A). Nothing here beats physics;
design targets must assume the floor, then measure how often PR reaches it. Target metric defined now:
**P99 app-perceived stall per training step < 15% of step time @ RTT ≤ 20 ms.**

---

## 2. Bandwidth Arithmetic

### 2.1 Reference points

| Link | Sustained |
|---|---|
| PCIe 4 x16 | ~32 GB/s |
| PCIe 5 x16 | ~64 GB/s |
| Gigabit FTTH (typical consumer, ASYMMETRIC) | ~110 MB/s down (~880 Mbit/s) / ~40 MB/s up (~320 Mbit/s) |
| Consumer 400/40 Mbit/s tier | ~45 MB/s down / ~4.5 MB/s up |
| Datacenter 10 Gbps | 1.2 GB/s |
| RDMA RoCE LAN | 25+ GB/s |

Gap vs PCIe gen4 x16 (32 GB/s): **~290× on consumer DOWNLINK, ~800× on
consumer UPLINK** (gigabit-tier), ~30× on 10 Gbps datacenter links. Model
H2D uploads against the user's UPLINK and readbacks/rendered frames against
their DOWNLINK — they differ by 3–10× on real tiers, and the uplink is
almost always the binding constraint. Consequences:

- Anything that moves per-frame full-rate over consumer links is dead
  (re-uploading 8 GB weights per session start ≈ 3.5 min on a ~40 MB/s
  gigabit-tier uplink — but ≈ 30 MINUTES on a 40 Mbit/s uplink. First-session
  UX is dominated by which tier the user has: Warm-Pool snapshots,
  kernel/asset caches, and same-user resume matter proportionally).
- Steady-state AI loops are naturally fine: activations/deltas are MB-scale,
  commands are KB-scale. A 7B model fits class-R once; per-step traffic then
  is gradients only if training (MBs), or near-zero for inference.
- Texture/video streaming (class S) must be scheduled as background bulk,
  never blocking p0/p1 lanes; a 21 MB 4K BC7 texture ≈ 0.5 s on a 40 MB/s
  uplink but ≈ 4.7 s at 40 Mbit/s — acceptable once, never per-frame.

### 2.2 Traffic model per workload class

| Class | One-time | Steady-state | Notes |
|---|---|---|---|
| Inference serve | weights (GBs) | KBs–MBs/s | PR pushes logits early |
| Training (single remote GPU) | weights+dataset staging | input batches + control, KBs–MBs/step | grads/optimizer state NEVER round-trip through the client |
| Diffusion burst | weights | activations per step | graphs shrink commands |
| Offscreen render | scene assets | per-frame deltas | BCn never recompressed |
| Viewport | scene assets | dirty-region updates | marginal viability driver |

### 2.3 Compression policy (content-class table)

| Content | Policy |
|---|---|
| BCn/ASTC/JPEG/PNG textures, video | never recompress; store-and-forward |
| fp16/bf16/int8 weights | entropy-code (lz4/zstd-fast level 1); expect 1.2–1.6× |
| Vertex/index streams | quantize+delta where API allows lossless transforms only |
| Command records | dictionary + varint + RLE; expect 5–20× |
| Status vectors | delta bitmaps; negligible size |
| Readbacks (fp32 buffers) | zstd medium; CPU-side cost acceptable off hot path |

Compression decisions happen per-record-class at the frontend, never by
opaque heuristics that could corrupt data (lossless only; lossy channels do
not exist in Phase 1).

---

## 3. Jitter, Loss, and Tail Behavior

- Interactive lanes (p0/p1) need tail discipline more than bandwidth:
  jitter buffer target ≤ 0.5·RTT; QUIC pacing + BBRv2-class congestion
  control; bulk lanes throttled whenever queue delay > α threshold.
- Packet loss on UDP-based transport: FEC (Reed-Solomon over command-ID groups)
  preferred over retransmit for small p0 records; ARQ fine for bulk.
- 5G handover events → multipath failover story (doc 05 §3.11).

---

## 4. Honest Envelope Verdicts (summary)

| Scenario @ intra-city (RTT ≤10 ms, link ≥100 MB/s down / 40 MB/s up) | Verdict |
|---|---|
| PyTorch training/inference, unmodified | ✅ production-viable target of Phase 1–2 |
| Stable Diffusion local UI driving remote GPU | ✅ good UX expected |
| Blender headless render farm-style | ✅ good |
| DaVinci encode/export | ✅ good |
| Blender viewport / CAD interactive | ⚠️ usable-with-pipelining, Phase 3+ research |
| Unreal/Unity editor remote-GPU | ⚠️ same, plus asset-pipeline complexity |
| Modern AAA game play | ❌ not with this architecture class |
| Competitive esports title | ❌ never claim it |

These verdicts are product commitments: the routing layer must refuse or warn
on classes we cannot serve honestly (ties into control-plane scoring).

## 5. Unit discipline (v0.2)

Every table in this document MUST be regenerable by small automated
calculations (checked into the repo alongside the simulator) so an Mbit/s vs
MB/s slip can never again silently alter strategy. Rule: all link figures
stated in BOTH Mbit/s and MB/s; all transfer examples show the arithmetic
explicitly; uplink and downlink modeled separately throughout.
