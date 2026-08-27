# Vectant Memory & Synchronization Semantics

Status: v0.2 (2026-08-24) · Planning only, no code
Supersedes: v0.1 draft
Depends on: `04-system-architecture.md` (Design Law C1–C6 + Superseding Rule)

v0.2 changes driven by external review: allocation is synchronous over an
attach-time arena (no optimistic malloc), the client returns REAL remote GPU
virtual addresses, API-visible status is host-confirmed truth only, callbacks
execute client-side, and reconnect safety comes from command deduplication —
not from any claim that GPU work is idempotent.

---

## 0. The Pointer Model (the foundation everything else stands on)

### 0.1 Decision: real remote virtual addresses

The client hands the application **actual `CUdeviceptr` values minted by the
remote GPU's allocator**. Not fake local VAs. Not opaque handles in pointer
clothing.

Why opaque handles fail: a `CUdeviceptr` is just a number. Applications copy
it into structs, add offsets, embed it in kernel argument blocks, stash it in
GPU memory, pass it through cuBLAS. `cuLaunchKernel` carries no type
information — Vectant cannot generically find every embedded pointer inside
arbitrary parameter bytes to translate handle→address at launch time. Any
design requiring that translation is unimplementable for real software.

With real addresses, a value that leaves the API and comes back inside a
parameter block is already correct for the target GPU. Zero translation.

### 0.2 Lifecycle

```text
cuMemAlloc(&p, N):
  client → ALLOC{N}                    (synchronous; see §1)
  host allocates really                (VMM/allocator)
  host ← {p_real}
  client returns p_real to app
```

The CPU cannot dereference a `CUdeviceptr` anyway; handing through the remote
value is observationally identical to native behavior on the client side.

### 0.3 Validation and session isolation of addresses

- The host validates every pointer arriving in commands and argument blobs
  against session-owned VA ranges before use; out-of-range = protocol error,
  refusal ledgered (fail-closed).
- Sessions are isolated by the remote VMM: each session's allocations live in
  its own address space; one tenant's pointers are meaningless to another.
- Phase 2 option: reserve a stable session VA arena via CUDA virtual-memory
  APIs (`cuMemAddressReserve`) so addresses are deterministic across a
  session resume. Not required for Phase 1.

### 0.4 What stays opaque

Protocol-level resources that never escape into application-visible pointer
space — streams, events, modules, functions, graphs — remain session-scoped
opaque IDs. Only memory gets real addresses.

---

## 1. Allocation: synchronous truth over a pre-reserved arena

**Rule: allocation results are never speculated. Application behavior
branches on success/failure; a falsified success is un-retractable.**
(03 §4.1 stated this rule; v0.1 of this doc violated it — fixed here.)

### 1.1 Attach-time arena reservation

```text
ATTACH:
  host reserves the session VRAM arena (e.g., full exclusive-GPU capacity)
  host → client: guaranteed arena metadata {capacity, base constraints}
  this reservation IS the lease's memory guarantee

cudaMalloc(N):
  client suballocates from arena bookkeeping   (local, µs)
  sends ALLOC{N, region} to host               (posted, but see below)
  returns ptr = real remote address            (success is REAL — capacity
                                                physically exists)
```

Suballocation from pre-committed capacity requires no speculation: when the
app asks for less than remaining arena space, success is a fact, not a
forecast. The ALLOC record still flows to the host to create the VMM mapping;
subsequent writes to that region are ordered after the mapping by normal
stream semantics (writes go through the command path; nothing dereferences
device memory CPU-side).

### 1.2 Exhaustion and OOM honesty

- If N exceeds remaining arena: return native OOM immediately. Real error,
  right now, exactly like native CUDA.
- Fragmentation within the arena is managed by the client-side suballocator;
  if fragmentation makes a large request unsatisfiable despite total free ≥ N
  (possible with pathological churn), the allocator compacts metadata or
  fails with native OOM — never invents success.
- Host-side allocation failure after the fact (driver-level failure) surfaces
  as device-lost-class errors per §5 — same as native catastrophic paths.
- C3 (mirrored free-VRAM counter) applies only to *advisory* queries
  (`cuDeviceTotalMem`, mempool budget queries), never as a basis for
  promising allocation success beyond arena guarantees.

Phase 1 keeps cudaMalloc synchronous-with-arena: correctness first; the RTT
optimization arrives later only because the arena made it safe to remove.

---

## 2. Status: cached host truth, never predicted truth

**Normative rule (supersedes v0.1 C4 phrasing): prediction may change when
Vectant sends work, but never what the application is told happened.**

- The Status Oracle maintains **last-confirmed host state**: event E complete?
  fence F value? stream S idle? All entries originate from host-emitted facts.
- Polling (`cudaEventQuery`, `cuStreamQuery`, `GetCompletedValue`) resolves
  **locally** against confirmed state: known-complete → true instantly;
  unknown/pending → **not-ready until confirmation arrives**. Unknown never
  resolves true.
- Cost: apparent completion latency grows by network propagation. Accepted.
  Lying is not an option: an app that branches on `EventQuery()==true` to
  free buffers / send packets / mutate state cannot be corrected afterwards.
- Prediction exists ONLY inside the runtime: PR decides what to push early;
  the Batch Scheduler decides when to flush; prefetch decides what to stage.
  None of these alter any value returned through the native API.

### 2.1 Status Vector (host→client)

Unchanged from v0.1 mechanically — monotonic completion records, fence/
timeline counters, health — but re-framed: it is a **continuous stream of
confirmations**, not "answers" to be extrapolated. Cadence max(RTT/2, 2 ms),
delta-encoded, with sequence numbers + periodic full snapshots so lossy
delivery can resynchronize (see `09` §status framing).

---

## 3. Callbacks execute on the CLIENT

(v0.1 said host-side; that was wrong. A user callback is code + process state
on the user's machine; the host cannot invoke it. 02 §A.2 had the correct
shape.)

```text
kernel K launched; cuLaunchHostFunc(CB) enqueued after it
  → both records stream to host
  → host completes K, reaches callback position
  → host emits CALLBACK_REACHED{op_id}
  → client runtime invokes CB locally (native thread pool semantics preserved)
  → work enqueued AFTER the callback (same stream) must wait for CB completion
     → client holds those records until CB returns (native ordering kept)
```

Consequence stated honestly: callback-heavy applications acquire a WAN
synchronization boundary at each callback (≈1 propagation delay). That is
physics, modeled in `06` — not hidden.

---

## 4. Reconnect & replay: deduplication, not idempotence

**A kernel launch is NOT idempotent.** `counter++` executed twice ≠ once;
an optimizer step applied twice corrupts training. v0.1's "idempotent epoch
replay" claim was wrong as stated.

### 4.1 What we actually rely on

Every record carries a **monotonic command ID**. The host maintains an
execution ledger (highest contiguously-executed ID per stream). Safety rule:

> The host executes each command ID at most once, deduplicating retransmits
> BEFORE GPU execution.

Reconnect flow (same host session alive):

```text
network dies → host keeps: VRAM, CUDA context, execution ledger
client reconnects → HELLO{incarnation, last_acked_by_client}
host → ack-window status: which IDs are executed
client resends only unknown IDs → host drops duplicates by ID
session continues transparently
```

Exactly-once comes from dedup-at-host, not from any property of the work.

### 4.2 Failure-class split (normative)

| Event | Semantics |
|---|---|
| Transport loss, host session alive | transparent reconnect + resume (above) |
| Host daemon crash | native device-lost-class error |
| Physical GPU/host death | native device-lost-class error |

No warm failover in v1. A new host has no VRAM state; moving tens of GB over
consumer links takes minutes (`06`); transparent migration is a much-later,
economics-gated research item (replicated state), not a roadmap default.

### 4.3 Journal role adjustment

The client journal exists to enable fast resend of unacked IDs during
transport-loss recovery. It is a retransmission buffer, not a state machine
that replays onto fresh hosts.

---

## 5. Managed / pinned memory — explicit non-goals for early phases

Honest stance (tightened per review): unified-memory page-fault emulation
over WAN is a degradation ladder, not a feature claim. Phase 1/1.5:
**unsupported** — surface native not-supported errors; apps using managed
memory get a clear signal, not silent pathology. Pinned/host-registered
memory: correctness via staging-copy emulation only; performance cliffs
documented; subset deferred to Phase 2 with measured expectations.

## 6. Placement classes (retained, simplified)

Classes R/P/S/T/D from v0.1 remain as *internal* placement policy for bulk
scheduling and cache decisions. They no longer imply any allocation-time
speculation: every allocation is real (§1); class only governs how/when bytes
cross the wire and where staging lives. Class M (managed) is out of scope per
§5.

## 7. What We Deliberately Do NOT Do

- No API-visible speculation of any kind (statuses OR values).
- No optimistic allocation, ever.
- No fabricated pointers; no pointer translation inside parameter blobs.
- No host-side execution of client callbacks.
- No claims that GPU work is idempotent; dedup is the only exactly-once mechanism.
- No warm failover in early phases.
- No wall-clock assumptions across the wire.
