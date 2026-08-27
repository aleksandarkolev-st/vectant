# Vectant Security, Isolation & Failure Semantics

Status: v0.2 (2026-08-24) · Planning only, no code
Supersedes: v0.1 draft
Depends on: `04-system-architecture.md`

Two trust directions define the problem:
1. **Host must not trust client** — the client sends arbitrary command streams
   that become driver calls and attacker-controlled GPU modules; a malicious
   client attacks the host driver, JIT compiler, and GPU.
2. **Client must not trust host** — the host necessarily sees the computation:
   model weights, shaders, prompts, data. Nothing below changes that physics;
   everything below bounds and audits it.

---

## 1. Host-Side Threats & Controls

| Threat | Control |
|---|---|
| Malformed records → driver crashes/persistent GPU corruption | Record schema validated before replay; fuzzing corpus as CI gate (repo mandate: hundreds of generated live scenarios); per-session isolation domain (below) |
| Driver/JIT 0-day exploited by hostile PTX/module uploads | **VM boundary, not container**: Phase 1 places each session's driver+GPU inside a hardware-virtualized guest (or equivalent strong boundary). Containers do NOT provide kernel security boundaries and are insufficient when feeding attacker inputs to a GPU driver |
| Cross-session information leak | One session = one exclusive GPU (Phase 1) + one VM ⇒ strongest practical isolation; full VRAM scrub + verification at release; no shared contexts ever |
| Resource exhaustion / noisy tenant | Lease-bounded arena quotas enforced at Memory Registry; cgroup limits in guest; metering anomalies → control-plane revocation |
| Unsupportable/exotic API paths | Phase 1 restricted surface (compat matrix `02`); unknown opcodes fail-closed, refusals ledgered (`refusal_proven` pattern) |
| Session hijack / replay | mTLS both directions with lease-bound certs; session incarnation IDs (`09`); command-ID dedup rejects replays |

**VM as invisible implementation detail:** this does not violate the product
promise — the USER is not in a VM; their machine stays theirs. The VM is a
host-side security boundary:

```text
USER LAPTOP: local Python → Vectant shim → QUIC
HOST:        vectant-hostd → [per-session VM → NVIDIA driver → physical GPU]
```

## 2. Client-Side Trust & Confidentiality (honest version)

Fundamental limit, stated plainly: **normal GPU execution cannot
cryptographically prevent a malicious host/operator from observing plaintext
the GPU must process.** Attestation, encryption at rest, verified wiping, and
SLAs raise the cost of betrayal and make it detectable; they do not make an
untrusted host trustworthy. Therefore:

| Measure | What it actually provides |
|---|---|
| Scrub-on-release + read-back canary, countersigned into ledger | Detectable, auditable hygiene — not secrecy from the operator during the session |
| Attestation (Phase 3) | Proof of software stack identity — trust anchor only if you trust the operator behind it |
| Encrypted VRAM regions where supported | Protects against co-tenants and some physical attacks — NOT against the operator running the VM |
| Zero-retention SLAs | Contractual, audit-enforced |

## 3. Trust Tiers for Supply (normative)

Sensitive workloads must be routable by tier, never by opaque "cloud" labels:

```text
T1 Vectant-owned infrastructure      (highest assurance)
T2 Certified datacenter partners     (audited, attested)
T3 Partner cloud providers           (contractual)
T4 Community/independent hosts       (cheapest, lowest assurance)
```

Control-plane routing exposes tier constraints as first-class rental
parameters; sensitive tenants can pin T1/T2. Default marketing must not blur
these lines.

## 4. Multi-Tenancy Stance

Phase 1: exclusive GPU per lease, inside its own VM. Sharing (MIG partitions,
time-slicing) later, gated behind isolation proofs. Never mix tenants on one
context or one VM.

## 5. Failure Semantics — three distinct classes (v0.2)

v0.1 blurred these; they are different products of the design:

| # | Event | App-visible behavior | Mechanism |
|---|---|---|---|
| F1 | Transport loss, host session alive | transparent stall, then seamless resume | reconnect + command-ID dedup (`05` §4.1) |
| F2 | Host daemon crash | native device-lost-class error | no state recovery attempted |
| F3 | Physical GPU/host death | native device-lost-class error | lease terminated, billing stops at last acked ID |

Only F1 resumes transparently in early versions. F2/F3 map to
`cudaErrorDeviceLost`-class errors apps already handle (C5). Laptop sleep =
F1 within lease grace. Latency spikes degrade performance only — correctness
never depends on latency (Design Law).

Normative rules unchanged: **no silent fallbacks, no hidden restarts, no
fabricated success.** Every degradation observable in telemetry and, where
apps must know, surfaced through native error codes.

## 6. Protocol security notes (details in `09`)

- No application command traffic on 0-RTT paths until dedup-under-replay is
  proven — replayed non-idempotent GPU work is exactly the hazard.
- Status/completion framing carries sequence numbers + periodic full
  snapshots so lossy delivery resynchronizes safely.
- All records MAC'd with session keys; incarnation IDs are AAD — cross-
  incarnation replay fails authentication.

## 7. Audit Ledger Integration

All security-relevant events (attach, auth failures, record refusals, scrub
completions, revocations, F1/F2/F3 classifications, dedup activations)
append to the signed control-plane ledger — matching this repo's decision
that mediated, auditable infrastructure IS the product.
