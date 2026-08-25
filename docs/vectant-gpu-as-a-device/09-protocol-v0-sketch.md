# Vectant Protocol v0 — Wire Sketch

Status: v0.2 (2026-08-24) · **EXPLICITLY UNFROZEN** — no field of this sketch
is committed until a local nvcuda proxy and a real remote GPU have executed
real workloads through it (roadmap phases 0A–0C). Simulation alone cannot
freeze a protocol whose hardest problems are semantic, not statistical.
Depends on: `04`, `05` v0.2 semantics.

v0.2 additions from review: version/feature negotiation, precise ACK
semantics, session incarnation IDs, reliable status framing with snapshots,
backpressure credits, cancellation, use-after-free ordering rules, bulk
integrity/retry, size limits, context multiplexing, no-0-RTT-for-commands.

---

## 1. Connection lifecycle

```text
CLIENT                          CONTROL PLANE                HOST
  │ rent(model,region,hours,tier?) ─►│
  │                                  │ score hosts, reserve lease+arena
  │                                  │ lease_token ───────────────►│
  │◄── attach{host_endpoint,         │                             │
  │        host_cert_fp, lease}      │                             │
  │ ═══════ mTLS/DTLS handshake (lease-bound certs; NO app data on 0-RTT) ══════►
  │ HELLO{proto_version, abi_version, client_caps, feature_bitmap} ⇄
  │       HELLO{proto_version, host_caps, feature_bitmap, device_truth,
  │               arena{capacity, va_layout_class}, incarnation_id}
  │   negotiate: version floor, opcode dictionary, compression classes,
  │   stream count, α/B_max defaults, status framing mode, size limits
  │ SESSION_ESTABLISHED (incarnation I, command-id space fresh per I)
```

- **Version negotiation**: `proto_version` (wire format) and `abi_version`
  (CUDA API coverage level) both negotiated; mismatch → clean refuse, never
  best-effort guessing.
- **Feature bitmap**: explicit capability exchange (graphs? mempools?
  pinned-emulation? events-v2? …). Features are OFF unless BOTH sides
  advertise them. No implicit fallbacks.
- **Device truth**: real remote properties served verbatim upward (`02` §H).
- **Incarnation ID**: fresh per host-session instantiation. Every record and
  status frame carries it as AAD; cross-incarnation replays fail
  authentication AND dedup logic is scoped per incarnation.

## 2. Streams (single QUIC connection)

| Stream | Dir | Priority | Framing | Content |
|---|---|---|---|---|
| s0 ctrl | both | p0 | reliable | keepalive, acks, credits, renegotiate |
| s1 status | host→cli | p0 | **reliable** (see §5) | confirmations |
| s2 cmds | cli→host | p0/p1 | reliable ordered per-stream-set | command records |
| s3.. bulk | both | p2 | reliable, parallel, preemptable | chunked transfers |

v0.1 called s1 "unreliable-friendly" — an error: QUIC streams are reliable.
Status is confirmation-bearing truth and MUST NOT silently drop. If lossy
low-latency delivery is later proven beneficial, it moves to QUIC DATAGRAM
with sequence numbers + periodic full snapshots — never to an ambiguous
"lossy stream."

## 3. Records, command IDs, and pointer semantics

```text
Record := { op: varint(dict idx), flags: u8, incarnation: u32,
            cmd_id: varint (monotonic), body_len: varint, body }
```

- Exactly-once execution = host dedups by `(incarnation, cmd_id)` BEFORE GPU
  execution (`05` §4). No idempotence assumptions anywhere.
- Memory arguments carry REAL remote GPU virtual addresses (`05` §0);
  streams/events/modules/graphs remain session-scoped opaque IDs.
- Every record naming a resource must respect lifecycle ordering (§6).
- Contexts: every record carries a context ID (Phase 1: single context per
  session; field present from day one so multi-context never changes the wire).

Representative ops: ALLOC/FREE, UPLOAD_CHUNK, LOAD_MODULE{cache_key},
LAUNCH, LAUNCH_GRAPH, MEMCPY, EVENT_RECORD/WAIT, STREAM_SYNC, READBACK_REQ,
FENCE_SIGNAL/WAIT, CALLBACK_REACHED_ACK (host→client), CANCEL, FLUSH_MARK.

## 4. ACK semantics (precise, three levels)

Ambiguity between "got it" and "ran it" broke v0.1's reconnect story. Norm:

| Signal | Meaning | Emitted when |
|---|---|---|
| RECEIVED | record entered host queue | on ingest (transport-level, may be implied by QUIC) |
| SCHEDULED | accepted, ordered into a stream's execution path | after validation + dependency check |
| EXECUTED | GPU work completed (or op trivially done) | via s1 status confirmations |

Reconnect protocol uses EXECUTED watermarks only: client resends everything
not known-executed; host drops duplicates by `(incarnation, cmd_id)`.

## 5. Status framing (confirmations)

```text
SV := { seq: u64, base: executed-watermark, deltas: completion records,
        fences/timelines: [(obj_id, counter)], health, full_snapshot_flag }
```

- Monotonic `seq`; receiver detects gaps; on gap or timer expiry it requests
  a **full snapshot** (periodic snapshots also sent proactively every N frames
  / T seconds). Deltas NEVER depend on unbounded history.
- Cadence max(RTT/2, 2 ms), coalesced. This is a confirmation channel only —
  the Oracle answers polls strictly from received facts (`05` §2).

## 6. Resource lifecycle & use-after-free protection

- Host enforces causal ordering: FREE/MODULE_UNLOAD take effect in command
  order; any later record referencing a freed ID is a protocol violation →
  session-scoped refusal, ledgered (fail-closed), never silent reuse.
- Client-side ledger prevents local misuse; host-side check is authoritative
  (defense against buggy/malicious clients).
- Deferred-destruction APIs (event/query lifetime races) follow native CUDA
  semantics: destruction is ordered, not immediate; documented in the ABI
  notes.

## 7. Flow control, cancellation, limits

- **Credits**: bulk transfers move under per-direction window credits;
  command streams have bounded outstanding-bytes ceilings. No unbounded
  buffering anywhere; slow-host backpressure propagates to the client
  scheduler (which applies flush-law backpressure upstream).
- **Cancellation**: CANCEL{cmd_range_or_op} supported at SCHEDULED-or-earlier
  stage only where native semantics allow (mirrors cudaEventDiscourage-
  style honesty: already-executed work reports completion, not cancellation).
  Session teardown cancels all pending and scrubs.
- **Size limits**: every variable-length field has negotiated maximums
  (module blob, record body, chunk size); violations fail closed. Hostile
  clients meet validation, never driver paths.

## 8. Bulk integrity

Chunked transfers carry per-chunk checksums + transfer IDs; retry is
per-chunk with host-side reassembly accounting; partial-transfer resumption
after F1 reconnect resumes from highest contiguous chunk. Compression codecs
are content-class registered (§v0.1 registry retained; lossless only).

## 9. Security bindings

- Lease token binds {user, host, gpu_id, window, tier}; presented inside the
  handshake; channels cannot outlive leases.
- Records MAC'd with session keys; `incarnation` + `cmd_id` are AAD.
- **No application commands on 0-RTT.** Replayed 0-RTT requests × non-
  idempotent GPU work is a forbidden combination until replay-dedup is proven
  in practice (0C kills connections deliberately to prove it). 0-RTT carries,
  at most, idempotent resume probes.

## 10. Completeness checklist (each item resolved before freeze)

| Area | Status in this sketch |
|---|---|
| Protocol/ABI version negotiation | §1 ✓ |
| Feature bitmap | §1 ✓ |
| Error stream (async driver/JIT/device errors) | required — op class ERROR_PUSH defined; framing TBD in 0C |
| Backpressure/credits | §7 ✓ (numbers TBD from 0D) |
| Cancellation/abort | §7 ✓ (semantics TBD vs native in 0B) |
| Resource lifecycle ordering | §6 ✓ |
| Pointer/VA semantics | §3 ✓ real addresses (`05` §0) |
| Context/process IDs | §3 ✓ (multi-process: Phase 2) |
| Bulk integrity/partial retry | §8 ✓ |
| Size limits | §7 ✓ |
| Full-vs-delta status framing | §5 ✓ |
| Incarnation IDs | §1, §9 ✓ |
| Precise ACK meaning | §4 ✓ |
| Reconnect rules | §4 + `05` §4 ✓ |

Freeze criteria (post-0C): checklist fully resolved against measured
behavior; α/B_max/status cadence defaults chosen from 0D sweeps; dictionary
coverage ≥95% of recorded trace ops (ESCAPE fallback otherwise).
