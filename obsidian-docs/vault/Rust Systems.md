---
tags: "rust", "webrtc"
system: Rust Systems (WebRTC Worker & Local Support App)
source-repo: vectant-ade
generated: 2026-08-25
---

# Rust Systems (WebRTC Worker & Local Support App)

> [!info] Provenance
> Deep-dive analysis generated from the live repository tree (`main` @ `ce74771af`, 2026-08-25).
> Raw source: `docs/obsidian-src/rust-systems.md` in the repo. All paths below are repo-relative unless noted.

---
tags: [vectant-ade, rust, webrtc, signaling, coturn, android-emulator, local-support, security]
source-repo: C:\Users\polek\Desktop\hermes-abuse\vectant-ade
analyzed: 2026-08-25
status: two independent Rust subsystems — cloud streaming/compile backend + trust-sensitive local desktop app
---

**Rust Systems — Architecture Analysis**

vectant-ade contains **two unrelated Rust subsystems** plus one nested duplicate tree:

| Subsystem | Path | Size | Role |
|---|---|---|---|
| Synthi WebRTC Compiler | `backend/synthi-webrtc-compiler/` | 2 crates + vendored patch, 267 `.rs` files in `worker/src` alone | Cloud/local compile-and-stream backend: compiles user C++/Java/Android projects, runs them under Xvfb/GStreamer, streams the GUI to browsers over WebRTC; also hosts GPU HMR (see [[GPU HMR System]]) |
| Vectant Local Support App | `backend/vectant-local-support-app/` | ~19 lib modules (10.4k LOC) + Tauri 2 desktop shell (4.2k LOC) | Trust-sensitive local support bridge: loopback-only HTTP API + cloud relay that lets a Vectant support session read *approved* local context with local-first policy enforcement |
| Nested duplicate | `backend/backend/synthi-webrtc-compiler/` (+ `collab-server`, `y-sweet`) | 18 MB vs 21 MB live tree | Stale mirror — see §4 |

---

## 1. backend/synthi-webrtc-compiler — the compile/stream backend

Not a Cargo workspace: two standalone crates (`worker/`, `signaling-server/`), each with its own lockfile and Dockerfile. The README's five-step dev flow is the product in miniature: signaling-server → worker → Next.js frontend → click RUN on a `.cpp` file.

### 1.1 `signaling-server` crate (v0.2.0)

Single-purpose WebSocket rendezvous server, ~1.4k lines in `src/main.rs` + `src/agent_auth.rs`. Deps are minimal: tokio-tungstenite, redis, reqwest, hmac/sha1/sha2.

**Session-multiplexed routing model** (documented in the main.rs header):
- Peers register `{type:"register", role:"browser"|"worker"|"observer"|"mcp-agent", session_id:"<workspace>-<user>"}`.
- Browser and worker are singletons per session (re-registering a browser evicts the prior sender); observers are unlimited. SDP/ICE route only between peers sharing a `session_id`.
- **Redis Pub/Sub relay**: any signaling pod can forward a message to whichever pod holds the peer's socket → horizontal scaling without sticky sessions (`REDIS_URL`, `NODE_ID` env).

**Auth & TURN credential minting** (`agent_auth.rs`, "Phase 4"):
- Opt-in HS256 "JWT-ish" agent-token verification gated by `SYNTHI_AGENT_TOKEN_SECRET`; claims require `scope == "mcp-agent"` so frontend user tokens can't be reused for backend agent access.
- When `SYNTHI_TURN_URL` + `SYNTHI_TURN_SECRET` are set it mints short-lived coturn REST credentials (`use-auth-secret`, draft-uberti-behave-turn-rest-00, HMAC-SHA1) returned in the `registered` ack — MCP agents get TURN without an extra trip.
- Spawner webhook: on session end it POSTs `COLLAB_SERVER_URL/api/spawner/session-ended` so the collab-server can tear down per-session worker pods (K8s mode keeps static worker replicas at 0; collab-server scales them via `/api/spawner/ensure|touch`).

### 1.2 `worker` crate (v0.1.0) — the heart of the system

Produces three artifacts from one crate:
- `lib worker` (`src/lib.rs`) — modules below
- bin `worker` (`src/main.rs`, 5.3k lines) — orchestrator + WebRTC peer
- bin `runner` (`src/runtime/runner_bin.rs`, 2.4k lines) — host-side plugin loader

Feature flags: `gpu-hmr` (device-compile stage for CUDA/HIP sidecars; off ⇒ manifests still parse but device compile no-ops), `backtrace`, and `legacy_hmr_tests` (stale pre-gpu-hmr test assertions, gated off by default — noted honestly in Cargo.toml).

Heavy deps tell the story: `webrtc` 0.9 (webrtc-rs), `gstreamer` 0.21, `tonic/prost` 0.11, `x11rb` (xtest/shm input injection), `libloading` (dlopen hot-swap), `object/gimli` (ELF/DWARF layout hashing), `iced-x86` (x86-64 immediate patching), `tree-sitter-cpp` (value-only edit classification), `rmp-serde` (msgpack state snapshots), `notify` (fs watching), `object_store` w/ GCP feature (GCS workspace sync).

#### Module map (`worker/src/`, 267 files)

- **`android/` (44)** — Android emulator + mobile-framework pipelines:
  - `emulator/` — AVD lifecycle daemon: launch, KVM checks, SDK health, idle shutdown, logcat, shutdown/session types.
  - `emulator_grpc/mod.rs` — tonic client against the Android emulator gRPC endpoint. `build.rs` compiles `proto/services/emulator-controller/proto/emulator_controller.proto` (vendored from the AOSP aemu proto set: adb, bluetooth, snapshot, ui-controller, sensor, modem, rtc, waterfall…) via tonic-build + protoc-bin-vendored; when protoc is missing it sets `cfg=synthi_no_protoc` and every client degrades to a stub returning errors — the build never hard-fails. Provides `stream_frames` (streamScreenshot RGB888 → mpsc channel), tap/swipe/key/text injection, optional token auth.
  - `webrtc/` — GStreamer capture pipeline for the emulator window (ximagesrc/XID capture → VP8/H264 → RTP packets fed into the shared `TrackFanout`), plus mobile message protocol.
  - `react_native/`, `flutter/`, `job/` — Gradle/flutter build runners, project detection, SDK health, per-project emulator job orchestration.
  - `fs/`, `workspace_reconcile.rs`, `routing.rs`, `env.rs`.
- **`hmr/` (129)** — the largest module: the whole hot-module-replacement machine. 124 submodules covering candidate queue/supersession/watchdog, dependency graph, dirty classification, deterministic compile, manifest heal, slot manager, state snapshot/migration/diff/restore (msgpack binary state), rollback notifications, rollout flags, planner glue, fast-refresh boundary checker, AI-assisted paths (ai_gate, ai_cache, ai_circuit_breaker, ai_cost_tracker, ai_fallback_chain…), and the **GPU family** (gpu_module_adapter, gpu_reload_orchestrator, gpu_fission, gpu_shadow_arena, gpu_stream_drain, gpu_dirty_bit, gpu_device_fast_path, gpu_driver_loader, gpu_proof…) — analyzed separately in [[GPU HMR System]]. `binary_patch/` implements tier-0 literal patching: DWARF line maps, x86 integer-immediate patching, float patching, /proc/self/mem patching.
- **`runtime/` (33)** — the plugin runner: `loader.rs` dlopens compiled `.so` slots; `runner/` context+validator+capture; `backends/` GLFW/raylib/SFML/SDL2 window backends + selector; `hot_reload/`, `supervisor`, `process_isolation`, `gpu_runtime_boundary`/`watchdog`, `plugin_contract`, `path_c/`, `platform/`. The frozen host↔plugin contract is spec'd in `PLUGIN_ABI.md`: three module slots (`core`/`gui`/`main`), GUI-only reloads preserve core state, HotApi v2 swap = same-version copy / msgpack migrate / cold-init.
- **`compiler/` (26)** — build stages (`stages/compile_core|gui|device|runner|helpers`, pch, ptxas info parser, guardrails), error parser, ABI versioning, source maps, Java compiler path (`java/`).
- **`safety/` (11)** — HMR hardening: hardened IPC (frame-size/read-timeout caps), quiescence, restart control with backoff + known-good store, boundary/fingerprint checks, slot isolation, guest registry, focus probe, `security.rs` (startup audit of enforced/partial/stub controls).
- **`infra/` (15)** — GCS workspace storage/cache (`storage.rs`, object_store + creds from env), fs watcher, dep/LSP installers, crash recovery, observability (StructuredLogger JSON/human, MetricsAggregator), a small WS update-broadcast server (`server.rs`), host KV.
- **`webrtc/` (5)** — multi-peer wiring: `PeerRegistry` (browser single-slot eviction vs multi-slot observers), `TrackFanout` (GStreamer writes once, broadcast fan-out per peer track), `broadcast_build_log_text` (50 ms per-DC timeout so a wedged data channel can't throttle others), `InputLease` registry (cross-peer single-holder input arbitration — companion to the MCP's lease.ts; observers never hold leases).
- **`main.rs`** ties it together: installs X11 error handlers first (Xvfb tear-down must not exit(1) the worker), prints security audit, initializes HMR v2.1 infra (StructuredLogger, IsolationManager, RestartController, IpcConfig, HmrOrchestrator), `gst::init()`, connects to signaling (`SIGNALING_URL`, default ws://localhost:9000; no SESSION_ID ⇒ registers as `__legacy__` accepting any browser session), negotiates webrtc-rs PeerConnections (TURN creds via `COMPILER_ICE_SERVERS`/fetched credentials), pumps GStreamer frames as `TrackLocalStaticRTP`, and bridges data channels (file-sync, compile-request, build-log, gui-event) with SCTP backpressure helpers. Data-channel workspace sync pairs with GCS download caching.

Tests: `worker/tests/` holds 24 phase-named integration harnesses (phase3 compile manifest → phase12.6 HMR protocol, tier0 literal-patch suites, four window-backend suites, ccache/bench suites) matching the phased plans in `docs/`.

### 1.3 Relationship to compose services / WebRTC & coturn

In root `docker-compose.yml`:

- **`signaling-server`** service builds from this crate, listens on 127.0.0.1:9000, needs healthy `redis` and started `collab-server` (`REDIS_URL=redis://redis:6379`, `COLLAB_SERVER_URL=http://collab-server:1234`).
- **`worker`** service builds from `backend/synthi-webrtc-compiler/worker` (Dockerfile: rust:1.88 builder → heavy runtime image ~3–5 GB with compilers, GStreamer, Xvfb, LSP servers; Artifact Registry streaming for <10 s pod starts). Env wires it to `ws://signaling-server:9000`, ai-engine :8000, `/data/repos` (ro volume from collab-data); default build arg `WORKER_CARGO_FEATURES=gpu-hmr`; hardened container (cap_drop ALL, no-new-privileges, private IPC, 8 GB shm, restart unless-stopped because a dead worker silently hangs every later compile).
- **`coturn`** service (pinned coturn/coturn:4.7.0-r2 digest) provides local TURN relay: lt-cred-mech with synthi:synthi, no-TLS/DTLS, relay port range 49152–49200/udp, bound to localhost. The frontend hands browsers `LOCAL_TURN_URL=turn:coturn:3478` via `/api/turn-credentials`; the worker gets ICE servers through `COMPILER_ICE_SERVERS` or fetched TURN REST creds. Signaling-server's agent_auth minting is the production counterpart (Cloudflare TURN vars exist but are blanked locally — "local coturn handles relay").
- **`mcp`** service depends on signaling-server + worker and scrapes worker/signaling metrics; GPU overlays (`docker-compose.nvidia.yml`, `docker-compose.gpu-amd.yml`) swap the worker to `Dockerfile.gpu` with CUDA+ROCm toolchains and `SYNTHI_GPU_HMR=1`.
- In K8s (`k8s/README.md`) the signaling server is a stateless 2-replica deployment; workers scale 0→N per active session via collab-server spawner webhooks, each pod carrying a preview sidecar.

Flow: browser ⇄ signaling-server (WS: register/SDP/ICE) → worker establishes direct PeerConnection; media (GUI video) and data channels (edits, logs, file sync, input) then flow P2P browser↔worker; coturn relays when NAT blocks it; Redis lets any signaling replica route control messages.

---

## 2. backend/vectant-local-support-app — the trust-sensitive local app

Implements `docs/VECTANT_LOCAL_SUPPORT_APP_PLAN.md` + `PRODUCT.md`: a read-only, session-scoped, workspace-scoped bridge between one local dev environment and one Vectant support session. Trust slogan: *"Automatic where safe, visible always, permissioned when sensitive"*; PRODUCT.md design principle #4: *"Fail closed and explain why."*

### 2.1 Crate layout

Two crates, core library + Tauri 2 shell that depends on it by path:

**Core lib `vectant-local-support-app` (src/, ~10.4k lines):**
- `http.rs` (2.7k) — axum API surface. `bind_loopback()` binds **127.0.0.1 with port 0** (ephemeral; never a public/exposed port). Router endpoints: `/health`; `/v1/status`; file review; full-access enroll/graph/node/mutation/command/revert/processes/port discover/use; session pause/resume/fast-support/disconnect; approval approve/deny/revoke-all; port approve/revoke; preview gateway `/v1/preview/:port/*path`; history export/delete. Hardening baked in: 256 KB JSON body cap, rate limiter (120 req/min default), strict CORS origin allowlist (beta/app.vectant.dev/.com), version floor + emergency revoked-version list, `shutdown_cleanup` that disconnects session and revokes all approvals/ports/preview streams/full-access on exit.
- `pair.rs` — pairing & device identity. Ed25519 (ed25519-dalek) device keypair; one-time pairing codes with TTL + fingerprint; signed pairing proofs (server nonce + browser session + requested user id); **per-request device proofs** (SHA-256 over method/path/body + timestamp + nonce, verified against the paired public key). Private key at rest uses **Windows DPAPI** (`CryptProtectData`, `VECTANT-DPAPI-V1` file prefix).
- `policy.rs` — L0–L5 content classification × decisions {Allow, Deny, ApprovalRequired, RedactThenApproval} with Once/Session approval scopes; every decision carries reason + user-visible flag.
- `scanner.rs` — regex secret scanner (API keys, tokens, DB URLs, JWTs…) producing classified ScanReports before anything leaves the machine.
- `workspace.rs` — canonicalized-path containment (no `..` escapes), 256 KB max file reads, per-file consent receipts, safe relative-path resolution.
- `full_access.rs` — the explicitly privileged mode, modeled separately from review-first: capability enum (Enroll, CommandExecute, WorkspaceFileMutate/Revert, ProcessInventory, LocalPortDiscover/Use, …), consent receipts bound to sessions (max 8 h work-session TTL), graph-node addressing (≤20k nodes, ≤256 KB each), deny-by-default for unknown capabilities/fields/scopes/stale receipts.
- `mutation.rs` — Full Access file mutation: **no shell write path**; mutations addressed by current graph node + expected content hash, written via temp-file + journal, reversible only by transaction id (≤64 txns, 256 KB each).
- `command_broker.rs` — bounded, shell-free command execution (explicit executable + argv, timeout, output cap, cancellation, redaction count in results).
- `preview.rs` / `port_adapter.rs` / `process_adapter.rs` — approved-port preview gateway: hop-by-hop header stripping, response size caps, redirect/token guards, per-port granular grants (browser-preview vs agent-read vs interact vs screenshot vs state-changing methods), expiry, invalidate-on-process-change; loopback listener detection with native process-identity verification (windows-sys IpHelper/ToolHelp; libc on unix) so approvals bind to the actual listening process; scoped process inventory.
- `approval.rs`, `audit.rs` — approval queue with re-validation at approve time and time-boxed grants; append-only local audit store (hash-chained entries, 2 MB cap, export/delete endpoints) classifying events Control/Data/FullAccess/Mutation/Command.
- `ipc.rs` + `desktop.rs` — allowlisted IPC command set between Tauri renderer and daemon logic; desktop security report verifying tauri.conf.json posture (restrictive CSP, empty fs scope, shell.open disabled, clipboard/globalShortcut disabled, devtools off, updater pinned pubkey, CSP blocking loopback fetch from renderer, renderer cannot touch tokens directly).
- `update.rs` — update-manifest verification (Ed25519 signature, sha256 artifact hash, minimum-version floor, emergency revocation list).
- `session.rs`, `lifecycle.rs` — SessionGuard binding account/org/workspace/device fingerprint; pause/resume/disconnect state machine.

Bins are deliberately non-production: `local_support_test_daemon` (needs `live-test-daemon` feature) for integration tests. The shipped artifact is the desktop app.

**Desktop crate `vectant-local-support-desktop` (desktop/src, ~4.2k lines):**
- Tauri 2 app (`dev.vectant.local-support`, MSI/NSIS bundles, updater with minisign pubkey pinned in tauri.conf.json against updates.vectant.dev). Static UI in `ui/` (plain HTML/JS/CSS). Locked-down config mirrors the library's DesktopSecurityReport expectations.
- Exactly one IPC command exposed to the renderer (`local_support_ipc`) routed through `plan_desktop_ipc_action` allowlisting; all real work happens in Rust.
- `pairing_client.rs` (864) — talks to the cloud pairing service; `relay_client.rs` (737) — polls the Vectant web app relay (`/api/local-support/relay/device[+/payload]`, implemented in `synthi/src/app/api/local-support/relay/*`) instead of exposing any inbound port; deliveries carry full provenance (actor, capability, target classification, scanner/policy/protocol versions, expiry) and sensitive ones surface as `pending_relay_approvals` for explicit user action. 64 KB response cap.
- Feature-gated probe bin `local_support_live_relay` for staging relay tests.

### 2.2 Security model summary

1. **Local enforcement layer** — the plan's core rule: ignores/blocks are enforced locally; if a file is blocked the local app refuses to return it regardless of what the cloud asks. Default-deny fail-closed everywhere.
2. **Loopback-only, outbound-only** — HTTP API on 127.0.0.1 ephemeral port; cloud contact via outbound HTTPS polling relay; no inbound exposure, no hidden background access.
3. **Pairing + proofs** — one-time code + Ed25519 device identity; every subsequent request carries a signed proof bound to method/path/body hash/timestamp/nonce; keys DPAPI-protected on Windows.
4. **Workspace scoping** — canonicalized containment; no arbitrary filesystem browsing; 256 KB read ceiling; blocked-by-default list (.env*, *.pem/key/p12/pfx, id_rsa, .ssh/.aws/.gcp/.azure/.kube, node_modules, .git/objects…) plus content-level secret scanning/redaction before send.
5. **Visible activity** — hash-chained local audit log, review-before-send panel, recent reads/port requests surfaced in UI; instant pause/disconnect revokes approvals, ports, previews, and full-access grants atomically.
6. **Escalation isolated** — Full Access (commands, mutations, process inventory) is a separate explicitly-enrolled mode with consent receipts, TTLs, budget caps, journaled reversible mutations, and its own audit class; the MVP plan's original "read-only, no commands" stance survives as the default mode.

---

## 3. How the two subsystems relate

They don't share code or dependencies — they solve opposite halves of the same product promise ("prove what left the machine"):

- **synthi-webrtc-compiler**: cloud/container-side execution. User code runs remotely (compose worker or per-session K8s pod); the local machine only renders the WebRTC stream. Nothing of the user's local filesystem is involved.
- **vectant-local-support-app**: brings *selected* local context (files, ports, processes, logs) into a Vectant support session under local-first consent, complementing the remote-runtime story for developers diagnosing their own machines.

Shared vocabulary (session ids, actor/capability/classification fields, audit philosophy, "fail closed with explanation") shows they were designed as one trust narrative across cloud runtime and local bridge.

## 4. The `backend/backend/` nested duplicate

`backend/backend/` contains stale copies of `collab-server`, `synthi-webrtc-compiler`, and `y-sweet`.

Verification (file-tree diff): the nested `synthi-webrtc-compiler` is an **older snapshot**, not identical:
- Missing ~123 files present in the live tree, incl. `signaling-server/src/agent_auth.rs`, `worker/Dockerfile.gpu(.cuda)`, GPU compile stages (`compile_device.rs`, `pch.rs`, `ptxas_info_parser.rs`, `gpu_runtime_contract.rs`), all of `hmr/binary_patch/*`, and other newer HMR/GPU modules; contains 1 file absent upstream (`worker/.claude/settings.local.json`).
- `worker/Cargo.toml` and `hmr/mod.rs` differ accordingly; last meaningful commit touching it predates the live tree (live `worker/src/main.rs` fixed 2026-07-28 vs nested tree's last touch 2026-07-04; outer tree added 2025-11-27, nested added 2026-04-11).
- Same pattern for collab-server (nested copy last touched 2026-07-04, live copy actively developed through 2026-08-25).
- Nothing in docker-compose/k8s/cloudrun/scripts/package.json references `backend/backend/`; both trees are git-tracked, so it's committed cruft (~19–21 MB) — likely an accidental nested copy during some sync. Safe-deletion candidate after confirming no tooling references it.

## 5. Observations & risks

- **Legacy test debt is explicit**: `legacy_hmr_tests` feature gates stale tests; several `main.rs` imports sit behind commented-out blocks; stray logs/artifacts (`error.log`, `cargo_err.txt`, `rustc_out.txt`, `output.txt`) are committed inside `worker/`.
- **`__legacy__` session fallback**: a SESSION_ID-less worker accepts *any* browser session — convenient locally, worth double-checking in shared deployments (mitigated there by per-session pods + agent-token scope enforcement).
- **protoc-absent degradation** is graceful (stub gRPC clients + `synthi_no_protoc` cfg), which keeps Windows/dev builds working but can hide missing-emulator-functionality until runtime.
- The local-support app's security posture is unusually rigorous for its size: hash-chained audit, DPAPI key storage, process-identity-bound port approvals, signed per-request proofs, and self-verifying desktop config (tests in `tests/security.rs` assert these properties — 84 test fns).

---

## Related notes

[[Collab Server]] · [[Dojo Codesite Local Support]] · [[Environments and Ports]]

[[00 Home|🏠 Back to Home]]
