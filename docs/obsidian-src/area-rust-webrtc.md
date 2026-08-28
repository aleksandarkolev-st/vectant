---
title: Area — Rust WebRTC Worker + Signaling Server
repo_path: backend/synthi-webrtc-compiler
tags: [area, rust, webrtc, hmr, gpu, gstreamer, signaling, android]
status: reviewed
files: "~267 .rs in worker/src, 2 .rs in signaling-server/src"
---

# Area: Rust WebRTC Worker + Signaling Server

Exhaustive per-module analysis of the native backend under
`backend/synthi-webrtc-compiler`: the **Rust WebRTC worker** (`worker/`) and its
**signaling server** (`signaling-server/`). All line references are relative to
the repo root unless marked otherwise (e.g. `main.rs:L950` =
`backend/synthi-webrtc-compiler/worker/src/main.rs` line 950).

The worker is the execution plane of Synthi: it connects to the signaling
server over WebSocket, terminates WebRTC sessions from browsers/MCP agents,
receives compile requests, compiles user code (C++/CUDA/HIP/Java today),
runs it in isolated runner processes, streams video/audio back over RTP
(GStreamer capture of an Xvfb display), and drives **hot module reload**
(HMR) pipelines — including GPU device-code HMR (cubin/hsaco swap).

## 1. Workspace & Crate Layout

There is no workspace `Cargo.toml` at `backend/synthi-webrtc-compiler/`; the
directory holds two independent crates plus shared docs:

| Path | Kind | Notes |
|---|---|---|
| `backend/synthi-webrtc-compiler/README.md` | doc | Run instructions (signaling → worker → frontend), ICE/TURN env config (`NEXT_PUBLIC_ICE_SERVERS`, `COMPILER_ICE_SERVERS`, `AI_BACKEND_URL`), coturn docker example |
| `backend/synthi-webrtc-compiler/PLUGIN_ABI.md` | doc | Plugin ABI contract doc |
| `worker/Cargo.toml` | crate | Package name `worker` v0.1.0, edition 2021 |
| `signaling-server/Cargo.toml` | crate | Package name `signaling-server` v0.2.0 |

### 1.1 Worker crate targets & features (`worker/Cargo.toml`)

- `[lib] name = "worker", path = "src/lib.rs"` — all logic lives in the library.
- `[[bin]] name = "worker"` → `src/main.rs` (5,331 lines).
- `[[bin]] name = "runner"` → `src/runtime/runner_bin.rs` (2,430 lines) — the
  per-preview child process that loads user `.so` modules.
- Features:
  - **`gpu-hmr`** (default off): when enabled, the worker compiles
    `device.cu` / `device.hip` into sidecar cubin/hsaco and the GPU module
    adapter participates in hot reload. Without it, manifests carrying a
    `gpu` block still *parse* but device compile is a no-op and the
    orchestrator falls through to host-only paths. Gated modules are marked
    `#[cfg(feature = "gpu-hmr")]` in `hmr/mod.rs`.
  - **`legacy_hmr_tests`**: stale pre-gpu-hmr test assertions
    (`BuildSlot::Primary`, `HealthcheckStrategy::SymbolProbe`,
    `StateStrategy::PreservePointer`) kept compiling but gated off.
  - **`backtrace`**: optional `backtrace` dep.
- Key deps: `webrtc` 0.9 (webrtc-rs), `tokio-tungstenite` 0.21 (signaling
  client), `gstreamer(-app)` 0.21 (capture/encode), `tonic`+`prost`
  (Android emulator gRPC), `object`+`gimli`+`memmap2` (ELF/DWARF parsing),
  `iced-x86` (x86-64 disassembly for immediate patching),
  `tree-sitter-cpp` (AST-based value classification), `libloading`
  (dlopen), `x11rb` (input emulation + X tools), `notify` 8.2 (fs watching),
  `rmp-serde`/`rmp` (MessagePack state serialization), `object_store`
  (GCP storage), `reqwest`, `zip`/`tar`/`flate2`.
- **Vendored patch**: `[patch.crates-io] stun = { path = "vendored/stun" }` —
  a local copy of `stun` 0.5.1 fixing the `ErrorCodeAttribute` Display impl
  so a malformed TURN error response can't panic the ICE-agent task (see
  `vendored/stun/README_SYNTHI_PATCH.md`).
- Build script `worker/build.rs`: links `-lX11` on Linux; with
  `--features gpu-hmr` adds `-Wl,--export-dynamic` to both binaries so the
  Synthi GPU runtime-boundary C ABI symbols (`synthi_gpu_launch_raw`, buffer
  registration, save/restore) are visible to `dlopen(RTLD_NOW)`'d user
  modules; runs tonic protoc codegen for the Android emulator controller
  proto (`proto/services/emulator-controller/proto/emulator_controller.proto`),
  falling back to `protoc-bin-vendored`.

### 1.2 Signaling server crate deps

Minimal: `tokio`, `tokio-tungstenite`/`tungstenite`, `redis` (tokio-comp),
`reqwest` (rustls), `hmac`+`sha1`+`sha2` (hand-rolled HS256 JWT + TURN
creds), `uuid` v4, `serde(_json)`, `base64`. No web framework — raw TCP +
manual WS upgrade.

### 1.3 Worker `src/` inventory (267 files, by module)

| Module | Files | Lines | Theme |
|---|---|---|---|
| `hmr/` | 129 | 64,573 | Hot-reload pipeline incl. GPU HMR + binary patching |
| `compiler/` | 26 | 41,150 | Compile request handling (18.4k-line handler) |
| `runtime/` | 33 | 18,560 | Runner process, window backends, plugin ABI |
| `android/` | 44 | 16,251 | Flutter/RN → Android emulator pipeline |
| `infra/` | 15 | 7,520 | Watcher, KV, observability, storage, deps install |
| `safety/` | 11 | 6,939 | Isolation, quiescence, restart control, IPC hardening |
| `webrtc/` | 5 | 1,188 | Multi-peer PC registry, track fanout, input lease |
| root files | 4 | ~5,571 | `lib.rs`, `main.rs` (5,331), `env_setup.rs`, `test_path.rs` |

---

## 2. Worker Root Files

### 2.1 `src/lib.rs` (26 lines)

Crate root. Declares `pub mod android/compiler/hmr/infra/runtime/safety/webrtc`,
sets `#![recursion_limit = "256"]`, and defines:
- `debug_log!` macro (`lib.rs:L6-L13`) — eprintln gated on
  `SYNTHI_WORKER_VERBOSE=1`; used everywhere instead of bare prints.
- `verbose_enabled()` backed by a `OnceLock<bool>` (`lib.rs:L16-L20`).

### 2.2 `src/env_setup.rs` (204 lines)

`ensure_android_sdk_env()` — deterministically resolves the Android SDK root
from (1) `SYNTHI_ANDROID_SDK_ROOT`, (2) existing `ANDROID_SDK_ROOT`/`ANDROID_HOME`,
(3) common install locations; sets env vars if missing and prepends
`platform-tools`, `emulator`, `cmdline-tools/latest/bin` to PATH. Also
`load_android_env_file()` (parses the SDK's own env file) and
`log_android_env_diagnostics()`. Needed because `cargo run` doesn't source rc
files. Mirrored/re-exported via `android/env.rs`.

### 2.3 `src/test_path.rs` (10 lines)

Throwaway diagnostic bin-style helper printing current exe path and whether a
sibling `runner` binary exists. Dev scaffolding only.

### 2.4 `src/main.rs` (5,331 lines) — worker bootstrap & signal loop

Single-binary entrypoint. Major regions (line numbers verified):

- **L128–223 `fetch_turn_credentials()`**: Option-B TURN provisioning — GETs
  `{COLLAB_SERVER_URL}/turn-credentials` (shape `TurnCredentialResponse {
  iceServers: [...] }`) and converts to `RTCIceServer`s; falls back to
  `stun:stun.l.google.com:19302` when unset/failed.
- **L225–289**: `is_legacy_vscode_ws_tunnel_label` helper.
- **L291–348 `js_key_to_x11_keysym` / `js_key_to_sdl_keycode`**: keyboard
  mapping tables translating browser KeyboardEvent codes to X11 keysyms /
  SDL keycodes for input injection.
- **L444–502**: wire structs `CancelMobileJobRequest`, `CancelBuildRequest`,
  chunked-compile frames `CompileRequestChunk` /
  `CompileRequestChunkAssembly` (large compile requests are split across DC
  messages and reassembled; `prune_compile_chunk_buffers` /
  `evict_oldest_compile_chunk_buffer` bound memory).
- **L503–678 `assemble_compile_request_chunk`**: reassembly state machine for
  chunked compile requests keyed by transfer id.
- **L679 `get_signaling_url`**, **L690 `extract_fingerprint`** (TLS
  fingerprint extraction), **L706/L785 `dc_send_with_backpressure` /
  `dc_send_text_with_backpressure`**: data-channel send helpers with
  bufferedAmount-aware backoff so a slow peer can't OOM the worker.
- **L855 `install_x11_error_handlers`**: installs X11 error handlers *before*
  any X-using code so a broken X connection (e.g. Xvfb torn down mid-build)
  doesn't `exit(1)` the whole worker.
- **L902–949**: `requested_remote_read_path` / `remote_read_path_allowed` —
  path-safety checks for file-read requests coming over the DC.
- **`async fn main()` L950–1712** — bootstrap order:
  1. `install_x11_error_handlers()` (L960).
  2. Optional security audit dump via `SYNTHI_SECURITY_AUDIT=1`
     (`security::print_security_audit`, L962–973).
  3. **HMR v2.1 infrastructure init** (L975–1088): `StructuredLogger`
     (JSON via `SYNTHI_JSON_LOGS`, level via `SYNTHI_LOG_LEVEL`),
     `MetricsAggregator`, `IsolationManager` (model from
     `SYNTHI_ISOLATION_MODEL`: `single_worker` default /
     `worker_per_slot` / `grouped`), `RestartController` with
     `BackoffConfig` + `KnownGoodStore` persisted under temp
     `synthi_known_good/`, hardened `IpcConfig`, `HmrOrchestrator::with_config`
     (binary_state=true, max_snapshots=10, max_consecutive_crashes=3,
     strict_abi via `SYNTHI_STRICT_ABI`, max_boundaries_per_module=20),
     `QuiescenceConfig::default()`.
  4. Android SDK env fixup (L1092–1093), env diagnostics dump.
  5. `gst::init()` — fatal on failure (L1106–1114); `verify_tooling().await`
     checks required external tools (`infra::constants::REQUIRED_TOOLS`).
  6. Signaling connect (L1118–1148): `SESSION_ID` scopes the worker to one
     browser session (unset → `"__legacy__"` compat mode); sends
     `{type:"register", role:"worker"}`; spawns the ws→mpsc forwarder
     (`signal_tx/signal_rx`).
  7. Session stores (L1150–1233): `PeerRegistry` (multi-peer PCs),
     `pending_remote_candidates` buffer (trickle-ICE from werift arrives
     before the offer; capped 32/peer), `video_fanout`/`audio_fanout`
     (`TrackFanout`), terminal stdin store, SDL input store, `RunnerState`
     store, compile-task store, legacy compile cache, VS Code server kill
     channel, `IncrementalCache` (content-addressable, dir resolved via
     `hmr::runtime_artifact_cache::incremental_compile_cache_dir()` which
     avoids noexec mounts), speculative `SpeculativeCache(32)`,
     Fast-Refresh `BoundaryChecker`, workspace `tempdir()`.
  8. Build-system init (L1235–1423): broadcast channel `update_tx`;
     preemptive watcher via `watcher::setup_preemptive_watcher` with
     `PreemptiveConfig { speculative_delay_ms: 150, commit_delay_ms: 300,
     max_speculative_count: 5 }`; `builder::BuildSession`; side WS server
     `server::start_server("0.0.0.0:8001")` broadcasting update JSON;
     DC-forwarder task calling `broadcast_build_log_text`; blocking build
     loop consuming `PreemptiveMessage::{StartSpeculative,
     CancelSpeculative, CommitSpeculative, Changed}` driving
     `build_session.incremental_compile`.
  9. **Signal loop** (L1429–1686): parses `SignalMessage` per message and
     dispatches on `msg_type`:
     - `"offer"` (L1460): get-or-create peer PC via `create_peer` (fresh
       peer gets new PC + per-peer tracks subscribed to fanouts; re-offer /
       ICE restart reuses PC), set remote description, replay any candidates
       queued before the offer; handshake failures are scoped to the arm
       (never `?`-bubbled — a single bad offer must not kill the watcher).
     - `"candidate"` (L1614): if the peer hasn't offered yet, stash in
       `pending_remote_candidates`; else add to PC.
     - `"reset"` (L1641): close every registered PC (dropping handles also
       aborts fanout subscriptions), clear candidate buckets, clear runner
       state (kills emulator/GStreamer), kill VS Code server manager.
- **L1714–1741 `request_video_keyframe`**: fires `GstForceKeyUnit` upstream of
  the running encoder so newly-subscribed observers get an I-frame quickly
  instead of waiting out the natural GoP (`keyframe-max-dist=30` ≈ 1 s @30fps).
- **L1743–2048 `create_peer`**: builds the per-peer `RTCPeerConnection`
  (MediaEngine w/ VP8+opus, default interceptors, ICE servers from TURN fetch
  or env), inserts `PeerHandle` into `PeerRegistry` (single-slot Browser
  eviction), subscribes per-peer tracks to video/audio fanouts, ICE callback
  stamps outgoing candidates with peer_id, connection-state callback removes
  dead peers from the registry.
- **L2050–2170**: `directory_has_entries`, `copy_workspace_tree`,
  `resolve_mobile_workspace_path` — mobile job workspace staging.
- **`wire_peer_channels` L2172–4588** — the giant DC dispatch. Creates the
  `"build-log"` DC then handles per-label traffic:
  - `"compile"` (L2257): parses `CompileRequest` (with cancel-build /
    cancel-mobile-job intercepts at L2302/L2393), calls `handle_compile`.
  - `"build-log"` (L2599): client-side log acks.
  - `"terminal"` (L2606): routes stdin to running process via
    `terminal_input_store`; `source_label == "human"` distinction (L2677);
    `t == "gui-event"` (L2645) dispatches GUI events (mouse/key) into the
    session input path with structured logging.
  - `lsp-*` labels (L2939): language-server proxying (`rewrite_uris`,
    `LspSessionState` version tracking rejects out-of-order didChange).
  - `"file-sync"` (L4054): workspace file upload/sync protocol keeping the
    on-disk workspace fresh (feeds `storage.rs` download dedupe).
  - `"emulator-input"` (L4299): mobile touch/key injection.
  - `ext-host` (L4323): deprecated stub pointing at vscode-server channel.
  - `vscode-server*` (L4346): manages the vscode-server-manager.js child.
- **`handle_compile` L4589–4668**: assembles `CompileContext` (log DC, stores,
  PC, workspace, caches, orchestrator, logger, metrics, restart controller,
  IPC config, fanouts, supervisor store, `XvfbAllocator`) and calls
  `compiler::handler::handle_compile_request`; on error resolves the
  frontend compile promise with a JSON failure card so the IDE never hangs
  on "Compiling…".
- **L4670–4814**: `verify_tooling` (checks REQUIRED_TOOLS on PATH),
  `system_command` helper, `find_rust_sysroot_info`.
- **L4815+ `ensure_lsp_config`**: writes LSP configuration for sessions.


---

## 3. Worker `hmr/` — Hot Module Reload (129 files, ~64.5k lines)

The largest and most layered module. Organized as: (a) a **decision stack**
(classify → plan → gate → execute), (b) **adapter families** per language
(dynlib, managed JVM/.NET, process-swap, GPU), (c) **state management**
(snapshot/diff/migrate/restore), (d) **candidate lifecycle** (queue,
health check, promote/rollback), (e) **AI hardening** (gate/cache/breaker/
cost/fallback), (f) **Tier-0 binary patching** for sub-millisecond literal
swaps, and (g) the **GPU HMR subsystem** behind `--features gpu-hmr`.
Feature gates live in `hmr/mod.rs` (pure module list, no logic).

### 3.1 Decision & classification

| File | Purpose |
|---|---|
| `loop_classifier.rs` | `CompileLoop::{LoopA, LoopB}` + `LoopClassifierInput` → `classify_loop()` decides deterministic (AI-free, adapted project, fresh split) vs AI-assisted (initial adaptation / stale split / rescue after ≥2 consecutive failures / user request). |
| `loop_b_triggers.rs` | Enumerates `LoopBTrigger` reasons (never adapted, stale split, explicit request, failure threshold, structural change, ABI break) with `label()` + `is_degradation()`. |
| `compile_enrichment.rs` | `CompileEnrichment::from_classification` — stamps compile requests with loop type, adapted status, whether AI split should run, incremental-cache usage, source hash; `is_deterministic()/is_ai_assisted()`. |
| `hmr_eligibility.rs` | `check_hmr_eligibility` — can this runner accept hot reload? Returns adapter family + allow/block reason lists (GUI-mode? exports `on_update()`? blocking app?). |
| `adapted_project.rs` | `AdaptedProjectStatus` detection: does the workspace have valid core/gui/shared split files (+ optional Phase-4 host_runner.cpp)? Builders: `adapted`, `adapted_full`, `with_split_hash`. |
| `planner.rs` (371 L) | The deterministic reload planner. `PlannerInput { build_manifest, prev_manifest, adapter_matrix, rollout_flags, abi_changed, state_schema_changed, warm_runtime, consecutive_failures }` → `plan_reload()` → `PlannerOutput`. |
| `planner_decision.rs` | `ReloadDecision` enum: InProcessSwap / ManagedSlotReload / ProcessSwap / ColdReload / Reject, with `StateStrategy` (Preserve/Migrate/Reset), `FallbackStrategy`, `is_in_process()`, `preserves_session()`. |
| `planner_glue.rs` | `execute_planner_and_transition` — runs planner, applies result to lifecycle FSM + telemetry, returns serializable `PlannerNotification` for the frontend DC. |
| `scope_planner_bridge.rs` | Maps a `RebuildScope` + context (family, tier, snapshot support, ABI changed) into a planner-compatible decision. |
| `rebuild_scope.rs` | `calculate_rebuild_scope(ScopeInput)` → `ScopeResult`: Nothing / GuiOnly / CoreOnly / CoreAndGui / FullReload; scope merge (union); `includes_core()/includes_gui()`. |
| `shared_header_detect.rs` | `analyze_shared_headers` — a header "bridges" if it has dependents in both core and GUI groups → recommends scope escalation to FullReload. |
| `changed_files.rs` | `ChangeSet` accumulator: dedupe by path (last write wins), content-hash diff vs previous, `classify()` → `DirtyFiles` grouped by class, `has_rebuild_trigger()`. |
| `dirty_classifier.rs` | `classify_file` → `FileClass::{Core, Gui, Shared, BuildConfig, Resource, Ignored}` + `triggers_rebuild()`. |
| `dependency_graph.rs` | `DependencyGraph` with forward imports + reverse dependents index; `affected_by(_many)` computes transitive impact of a change. |
| `rollout_flags.rs` | Per-family `AdapterRolloutConfig` kill switches, tier caps, forced decisions, percentage rollouts; `is_killed()`, `effective_tier()`. |
| `abi_detect.rs` | `detect_abi_changes(prev, cur)` → added/removed symbol sets + how the comparison was made (explicit version string / exported symbols / schema hash). |
| `preview_lifecycle.rs` | Canonical `PreviewLifecycleState` enum every compiled route must transition through (Idle→Compiling→Built/Failed→Planning→Reloading…); UI maps directly onto these values. |
| `lifecycle_machine.rs` | Validated `LifecycleStateMachine` with transition table, elapsed-in-state, and `force_transition` recovery path. |

### 3.2 Orchestrator & pipeline integration

- `orchestrator.rs` (1,643 L): central `HmrOrchestrator` + `OrchestratorConfig`
  (see main.rs init) holding per-session pipelines; types `HmrResult`,
  `SchemaCompatibility`, `HmrStatus`, `SavedState`/`LoadedState`,
  `MigrationSummary`, `OrchestratorStats`, `MigratedState`.
- `integration.rs` (1,189 L): `HmrPipeline` — the per-session façade used by
  `compiler/handler.rs`: `ensure_adapter`, `enqueue_candidate`,
  `validate_active_candidate`, `reject_active_candidate`, `classify_loop`,
  `check_ai_gate`, `plan_reload`, `execute_reload`,
  `execute_gpu_device_reload`, `tick_candidates`; plus frontend
  notification envelopes (`AdapterStatusNotification`,
  `AiStatusNotification`, `StateRestoreNotification`,
  `AdapterHealthNotification`) and unit tests covering loop-A gating and
  failure counting.
- `telemetry.rs`: `LatencyHistogram` (fixed ms buckets, percentile()),
  `CompileSpan`/`ReloadSpan`, aggregated in `HmrTelemetry`.

### 3.3 Adapter families

- `adapter_trait.rs` (327 L): shared reload-request vocabulary —
  `ReloadArtifactBlob` (content-addressed artifact bytes, sha256, serde-skipped),
  `ReloadCapsuleMetadata` (proof/capsule identity incl.
  `from_gpu_device_sidecar_boundary`), `ReloadFirewallEvidence`.
- `adapter_matrix.rs` (365 L): `AdapterFamily::{NativeDynLib, ManagedRuntime,
  SnapshotExport}` × `CapabilityTier` (Tier0 compile+restart … Tier3 warm
  in-process) → `AdapterDescriptor` table (`default_matrix()`), with
  `supports_warm_reload()/supports_managed_reload()/supports_process_swap()`.
- `adapter_registry.rs` (248 L): factory `create_adapter_for_language`;
  GPU rows ("cuda","hip","rocm") only wired under `gpu-hmr`, else `None`
  → planner falls through to cold restart (Phase-0 contract).
- `adapter_lifecycle_fsm.rs`: common adapter states/events with recorded
  transitions and fault counts.
- **DynLib family** (`dynlib_*.rs`, 13 files): in-process dlopen swap for
  C/C++/Rust/Zig.
  - `dynlib_adapter.rs`: `DynLibAdapter` + config (languages, max artifact
    size, symbol validation, healthcheck ticks).
  - `dynlib_abi_contract.rs`: `AbiHeader` (major must match, minor >=
    expected), required/optional symbols (`hmr_get_abi_version`, …),
    `canonical_abi_contract()`.
  - `dynlib_symbol_resolver.rs`: `SymbolTable`, contract-checked resolution.
  - `dynlib_language_profiles.rs`: per-language mangling (C/Itanium/MSVC/Rust v0)
    + calling conventions.
  - `dynlib_build_hooks.rs`: mandatory flags (-fPIC, -shared, -rdynamic).
  - `dynlib_swap.rs`: supervisor↔worker command protocol (Quiesce/Snapshot/
    SwapLibrary/Resume) with acks and phases.
  - `dynlib_reload.rs`: `orchestrate_dynlib_reload` driving canonical phases
    with per-step timing; rollback on any phase failure.
  - `dynlib_rollback.rs`: `FailurePhase`-dependent rollback depth decision.
  - `dynlib_preload_validator.rs`: pre-dlopen sanity (size, extension,
    min exported symbols, ABI header).
  - `dynlib_state_bridge.rs`: state export/import via JSON or MessagePack
    (`hmr_get_state_json` / `hmr_set_state_binary` …); prefers binary.
  - `dynlib_crash_isolation.rs`: `CrashGuard::guarded_call` wrapping calls
    with crash kind detection (SIGSEGV/abort/timeout/panic) + pre-call
    snapshot flag.
  - `dynlib_metrics.rs`: per-phase timing stats.
- **Managed runtime family** (`managed_*.rs`, 7 files): JVM/.NET hosts.
  - `managed_agent_protocol.rs`: framed host↔agent commands (Handshake,
    PrepareReload, CommitReload, RollbackReload, ExportState, ImportState,
    HealthCheck) with versioning.
  - `managed_classloader_strategy.rs`: JVM change kinds → JVMTI hotswap-safe?
  - `managed_dotnet_reload.rs`: .NET assembly changes → EnC (Hot Reload)
    safe? (.NET 6+ rules).
  - `managed_runtime_adapter.rs` / `managed_runtime_hooks.rs`: adapter impl +
    strategy selection (Instrumentation vs ClassLoaderRestart vs
    AssemblyContextUnload vs HostRestart) and command building.
  - `managed_health_probe.rs`: ping/heap-based degraded/faulted verdicts.
- **Process-swap family** (`process_swap_*.rs`, 5 files): new candidate
  process, old process exports state via IPC.
  - `process_swap_adapter.rs`: `ProcessSwapAdapter` + config (ready timeout,
    handoff timeout, overlap count, cgroup isolation flag).
  - `process_swap_drain.rs`: drain old process's in-flight requests within
    budget; force-kill option.
  - `process_swap_handoff.rs`: `HandoffEnvelope` (magic/version/module/schema/
    payload/CRC32/timestamp) file read/write.
  - `process_swap_socket_handoff.rs`: listening-socket transfer strategies
    (SCM_RIGHTS fd-passing, LISTEN_FDS, named pipe, close-and-rebind).
  - `process_swap_state_transfer.rs`: transport selection
    (pipe/shared-mem/temp-file/unix socket) + checksum verify.

### 3.4 Candidate lifecycle

`candidate.rs` defines `CandidateId` + `CandidateState`
(Built→Loading→HealthChecking→Validated→Promoted / RolledBack / Discarded);
`candidate_queue.rs` is the thread-safe queue (bounded, enqueue supersedes
older pending candidates); `candidate_bridge.rs::bridge_tick` inspects the
active candidate each tick and yields `BridgeAction::{Load, HealthCheck,
Promote, Rollback, Discard, None}`; `candidate_watchdog.rs` applies
per-state timeouts; `candidate_supersession.rs` decides whether a newer
build displaces an active one (policy: never supersede past health-check);
`candidate_history.rs` keeps a bounded log + aggregate stats;
`candidate_notification.rs` emits typed lifecycle events as JSON to the
frontend; `promotion_policy.rs` gates promotion on health evidence +
latency/cooldowns; `health_check.rs` models `HealthCheckResult` +
strategies (symbol probe / first-tick / HTTP probe / exit code) with
timeouts+retries; `swap_rollback.rs` records rollback reasons with
`is_permanent()/needs_restart()` triage; `rollback_notification.rs` maps a
rolled-back candidate to a frontend notification with reason codes;
`hot_swap_coordinator.rs` plans the whole quiesce→snapshot→load→restore→
health sequence with per-phase timeouts and timings.

### 3.5 Slot management & protocols

- `slot_manager.rs` (553 L): two-slot scheme (`LibSlot`, primary/standby).
  `SlotKind::{Host, Device}` added for GPU-HMR Phase 1 (docs/GPU_HMR_ULTRAPLAN
  §5.3): device modules reuse the two-slot scheme but the planner must
  distinguish host `.so` swaps from cubin/hsaco swaps when choosing which
  adapter to drive.
- `reload_protocol.rs` (716 L): `ReloadId` + `ReloadState` machine for one
  reload op (Requested→Quiescing→Snapshotting→AwaitingReadyForKill→Killing→Spawning…)
  with typed errors.

### 3.6 State management (host)

- `state_manager.rs` (742 L): `StateHandle` — raw pointer wrapper carrying
  owning module, boundary, ABI version, source-content hash, optional JSON
  snapshot, timestamps, migration schema ref.
- `state_snapshot.rs`: versioned `StateSnapshot` (id, module, schema+ABI
  versions, source hash, payload, per-field checksums) + `compare_snapshots`.
- `state_checkpoint.rs`: policy-driven checkpoint manager (min/max interval,
  before-every-reload flag, per-module ring buffers).
- `state_diff.rs`: field-level diff/merge with preserved/reset policies
  (`for_gui`, `for_core`, dot-notation nested resets).
- `state_migration.rs`: registry of migration steps (field adds/removes/
  renames, defaults, reversibility) forming `MigrationPath`s.
- `state_restore_orchestrator.rs` / `state_restore_validator.rs`: decide
  ApplyDirect / ApplyThenMigrate / Discard; validate against target module's
  required fields, size limits, layout hash.
- `state_serializer.rs` + `state_size_limiter.rs`: format selection +
  per-module/global byte budgets with warn thresholds and migration overflow.
- `binary_state.rs` (2,309 L): allocation-free binary serialization —
  `StateWriter` trait (CountingWriter/SliceWriter), `MsgPackSerializer`
  producing `MsgPackState` payloads via generated code
  (`generate_msgpack_serialization_code[_with_defaults]` from parsed
  `AppState` fields), `BinarySchema(Builder)` describing layouts,
  `SchemaMigrator`/`BinaryMigrator` for in-place payload migration, and
  `binary_to_debug_json` for diagnostics.
- `state_type_id.rs` (970 L): stable per-type identifiers — extracts a
  `StateTypeId` ELF note from compiled modules (`extract_state_type_id`,
  DWARF struct layout lookup), computes 64-bit layout hashes, and classifies
  `TypeEquivalence::{Identical(memcpy ok), CompatibleLayout, Incompatible}`
  → `MemcpySafety`/`ReloadSafety` verdicts.
- `device_snapshot.rs` (491 L, gpu-hmr): `DeviceStateSnapshot` inside
  `StateSnapshotV2` — capture tier (mirrors `compile_manifest::SnapshotMode`
  minus Auto), CUDA device ordinal (restore across devices = hard fail),
  VRAM payloads serialized with rmp-serde.
- `device_checkpoint_probe.rs` (gpu-hmr): logging probe around device
  checkpoints.

### 3.7 Fast Refresh / Tier 0 / speculative paths (sub-second edits)

- `fast_refresh.rs` (936 L): React-Fast-Refresh-inspired boundary checker for
  the split-module model. `BoundaryChecker::analyze_source` extracts
  functions/state structs/exports/globals/ABI version/deps per module;
  `check_boundaries` diffs against baseline producing `BoundaryViolation`s
  (state layout changed, signature changed, non-component export added,
  global mutated outside hooks, ABI mismatch, CoreAPI change, module removed,
  new required dep) with `is_fatal()/requires_full_reload()`;
  `determine_action` maps violations to refresh actions.
- `ts_value_classifier.rs`: tree-sitter AST diff — is the change purely
  literal values? Produces `AstClassification` + `LiteralChange` list.
- `tier0_unified.rs` (621 L): `try_tier0_v2` pipeline — classify via AST,
  then dispatch string patches (DWARF lookup by source file → `.rodata`
  offsets) and integer immediate patches; returns `PatchRecord`s for live
  memory patching.
- `tier0_literal_patch.rs`: same-length string-literal swaps written into
  the compiled `.so` in place (atomic temp+rename), `Tier0Outcome`.
- `binary_patch/` (5 files):
  - `dwarf_line_map.rs`: source line → instruction addresses (gimli).
  - `imm_patcher.rs`: scans instructions at VAs for patchable integer
    immediates (iced-x86 decode), `patch_immediate` rewrites the operand.
  - `float_patcher.rs`: finds RIP-relative movss/movsd loads and patches the
    IEEE-754 bytes in `.rodata`.
  - `proc_mem_patcher.rs`: `/proc/<pid>/maps` base-address resolution,
    file-offset→VA translation via ELF LOAD headers, and live process-memory
    writes — Tier 0 without even swapping libraries.
  - `mod.rs`: re-exports.
- `diff_patcher.rs` (522 L): transplant user edits into the AI-generated
  split files (core.cpp/gui.cpp/shared.h) using normalized line matching;
  reports unmatched lines.
- `edit_classifier.rs` + `edit_applier.rs`: classify old→new source into
  labeled hunks; apply anchored InsertBefore/InsertAfter/Replace/Delete ops
  (anchor uniqueness enforced) — this is the `/refactor/diff_patch` Tier-2
  contract.
- `speculative_diff_patch.rs` (535 L): speculative executor — generation
  counter detects supersession; debounce-gated background speculation whose
  results are consumed by `take_matching` when the real compile lands.
- `undef_symbols.rs`: parse linker stderr for undefined references
  (deduped, Mach-O underscore stripped) for AI healing hints.
- `incremental_cache.rs` (1,559 L): content-addressable compile cache:
  `CacheEntry` keyed by source content hash + compiler-flag hash +
  transitive include *content* hashes, CRC32 integrity, toolchain fingerprint
  (`ToolchainInfo::from_environment`), TTL/size eviction (100 MB default);
  exposes `compile_with_cache`, `link_objects`, `IncrementalCache`.
- `cache_writer.rs`: alternate writer abstraction (policy-capped entry count).
- `runtime_artifact_cache.rs`: resolves the cache dir honoring overrides and
  avoiding noexec mounts (GPU HMR may dlopen from it).
- `deterministic_compile.rs`: input/output contracts + budget checks
  (`exceeds_warm_budget`, `exceeds_cold_budget`) and input validation for
  the AI-free path.
- `ai_bypass.rs`: cached AI split results keyed by source hash
  (`SplitCache`) so repeated saves skip the expensive split call;
  `check_ai_bypass` decides whether the split can be skipped entirely.
- `diagnostics.rs`: normalized compiler diagnostics envelope (severity,
  location spans, snippet) sent to the IDE.

### 3.8 AI hardening subsystem (`ai_*.rs`, 10 files)

All AI-endpoint usage is wrapped in defensive machinery:
- `ai_gate.rs`: blocks AI calls during Loop A; tracks allowed/blocked counts
  and deterministic-path ratio.
- `ai_request_contract.rs`: typed requests/reasons/priorities/context
  snippets/responses/token usage.
- `ai_cache.rs`: LRU response cache keyed by semantic request key (ignores
  volatile fields).
- `ai_circuit_breaker.rs`: Closed/Open/HalfOpen breaker with configurable
  thresholds; timeouts count as failures.
- `ai_cost_tracker.rs`: token/cost budget per session with warning threshold.
- `ai_timeout_guardian.rs`: priority-aware adaptive timeouts from p95 history.
- `ai_response_validator.rs`: verdict + size/count/confidence caps on AI
  responses before anything is applied.
- `ai_fallback_chain.rs`: ordered degradation Retry → Cache → HeuristicRule →
  DeterministicBestEffort → ColdReload → FullRestart.
- `ai_extraction_tests.rs` (cfg(test)): extraction-path tests.

### 3.9 GPU HMR subsystem (feature `gpu-hmr`; plus always-compiled contracts)

The plan doc referenced throughout is `docs/GPU_HMR_ULTRAPLAN.md` (Phases 0–11).

- **`gpu_prod_contracts.rs` (4,986 L, always compiled)**: pure functions that
  normalize/promote sidecar metadata into production report shapes —
  `normalize_split_sidecar`, toolchain/target identity extraction from the
  manifest, device/generated-role mapping promotion
  (`promote_device_mapping_report`, `promote_build_metadata`),
  template evidence acceptance (`is_compiler_derived_template_evidence`),
  safety/memory-refresh/fault policies, launch-indirection gating
  (`launch_indirection_ok` / block reasons), fast-path policy +
  `decide_arbiter` + `ranked_reload_options`, failure-card templates
  (`run_failure_card`, `run_failure_reason_codes`), and run-report assembly
  (`run_report`, verifier-report promotion).
- **`gpu_module_adapter.rs` (5,004 L, gated)**: the CUDA/ROCm driver-facing
  adapter. `GpuVendor`, `GpuModuleAdapterConfig`, `GpuPhase`,
  `DriverLaunchDispatcher`, `DeviceReloadOwnership`,
  `ArtifactLoaderTransport`; kernel-table plumbing (mangled-name → CUfunction,
  dispatch-table hashing); **Runtime Output Oracle** — profile-driven replay
  probes that re-run kernel launches against recorded inputs and compare
  outputs to prove semantic equivalence post-reload
  (`RuntimeOutputOracleProfile/Buffer/Arg`,
  `run_runtime_output_oracle_profile/_replay/_probe`), proof model/provenance
  records, launch-arg provenance, canonical ledger proof ids.
- **`gpu_module_manager.rs` (1,216 L, gated)**: `ModuleSlot` (raw CUmodule as
  u64 handle to stay Send+Sync), `KernelTable` (name → CUfunction),
  `KernelResolution`, `KernelLaunchConfig`, `GpuModuleManager` with
  primary/standby slots: `load_standby[_from_file]`, `resolve_kernels`,
  `merge_standby_partial`/`drain_partial_modules`, `swap` (retire primary),
  `unload_retired` (cuModuleUnload at the safe boundary), `launch_kernel`,
  partial-module accounting + last-error tracking.
- **`gpu_fission.rs` (4,390 L, always compiled)**: verification engine for
  "fission" candidates — partial device-code islands extracted from a larger
  translation unit. Validates candidate evidence end-to-end: source spans
  within declared paths, include closure validity, loader-capability
  contracts, content-addressed artifact identity (sha256), generated-topology
  bindings binding candidate ↔ materialized partial artifact ↔ generated role
  path, oracle requirements, and rejection reason codes
  (`verify_fission_candidates` / `verify_fission_candidate`,
  `rejected_fission_reason_codes`).
- **`gpu_device_fast_path.rs` (3,906 L, always compiled)**: attempts to skip
  full recompilation for device-body-only edits. `try_direct_device_body_patch`
  (L70) computes kernel regions from source mappings, produces `BodyDelta`s
  and validates via an evidence battery: kernel signature snapshots/hashes,
  function body hashes, constant/global layout, directive diffs, include-graph
  roots, declaration surfaces, affected symbols, compile metadata — plus
  tree-sitter AST status (`parse_device_cpp_ast` with sanitized GPU
  annotations), identity-uncertainty tracking for mapped symbols, and
  verifier reports. Rejections either block fallback or allow split
  bootstrap depending on reason (`device_fast_path_rejection_blocks_fallback`,
  `missing_toolchain_allows_split_bootstrap`).
- **`gpu_reload_orchestrator.rs` (518 L, gated)**: plans the swap sequence —
  `plan_gpu_reload(GpuSwapInputs)` → `GpuReloadPlan` of steps
  (`append_device_swap`, mixed plans wrap host swap between device save and
  restore; ABI break → cold reload + on_load; drain timeout → cold restart;
  signature mismatch → rollback) plus runtime-fault recovery planning with
  retry caps (`plan_runtime_fault_recovery`,
  `GpuRuntimeRecoveryAction`).
- **`gpu_shadow_arena.rs` (714 L, gated)**: VRAM shadow copies of host-owned
  device allocations. `ShadowArena::register/sync_to_shadow/sync_from_shadow/
  release` with dirty short-circuiting; errors are typed
  (`ShadowArenaError`).
- **`gpu_stream_drain.rs` (516 L, gated)**: bounded-time stream drain before
  swap (`drain_context[_with_clock]`, `DrainOutcome::{Synced, BudgetExpired,
  DriverError}`) so callers decide escalation.
- **`gpu_driver_loader.rs` (534 L, gated)**: `try_load` resolves the full
  vendor symbol table (`GpuDriverSymbolTable`) or fails wholesale — no
  half-loaded drivers on the swap path.
- **`gpu_dirty_bit.rs` (387 L, gated)**: per-buffer dirty tracking with sizes,
  dirty-byte totals, ratios for telemetry, and iteration over dirty buffers
  for snapshot budgeting.
- **`gpu_proof.rs` (1,036 L, always compiled)**: proof-state machine
  (`GpuHmrProofState` ranked, `GpuHmrDegradedState`), machine-parseable
  telemetry lines, proof artifacts written/read atomically with sha256 refs,
  acceptance ledger validating the full hot-reload event chain including
  firewall evidence (`acceptance_ledger_accepts_full_hot_reload_event_chain`,
  rejects missing/non-GPU routes).
- `device_checkpoint_probe.rs` / `device_snapshot.rs`: covered in §3.6.

### 3.10 Integration test waves (cfg(test))

`wave05..wave12_integration_tests.rs` are end-to-end scenario suites per
pipeline stage: wave05 dynlib swap (eligibility→coordinator→slot→validate→
rollback), wave06 candidate runtime pipeline, wave07 dirty-unit detection
(change→classify→dep graph→scope→planner bridge), wave08 state hardening
(snapshot→serialize→validate→migrate→restore), wave09 AI hardening chain,
wave10 adapter families, wave11 DynLib deep dive (ABI contract→symbols→…),
wave12 managed/process-swap families + lifecycle FSM summary.

---

## 4. Worker `runtime/` — Runner & Window Backends (33 files)

- `runner_bin.rs` (2,430 L): the `runner` binary. Loads user modules into the
  runner process; handles `RunnerCommand`s; implements the runtime-control
  surface used by HMR: pause/resume execution flags, structured
  runtime-control status payloads, GPU kernel-command token decoding,
  `GpuReloadCompletion` emission, artifact loader transport negotiation
  (parse/env-driven), capsule-metadata decoding from tokens, backend
  selection (`select_backend_for_runner`), and `main`.
- `runner_logic.rs` (959 L): shared runner-side logic (command processing
  helpers reused by runner_bin).
- `runner_state.rs`: `RunnerState` builder (`new/with_gui/with_hmr_capability/
  with_xvfb`) stored worker-side per session (session id, GUI mode, Xvfb
  handle, capability info).
- `runner/mod.rs|context.rs|capture.rs|validator.rs`: runner support —
  `RunnerContext`; SHM segment creation + frame capture
  (`create_shm_segment`, `capture_frame`); `ValidationInfo`.
- `plugin_contract.rs` (1,301 L) & `compiler/plugin_contract.rs` (duplicate
  copy for the compiler crate side): ABI constants — Runner API version,
  Module API version (HotApi structure), minimum supported version, legacy
  ABI constants, Host KV API version, struct magic numbers, max sane
  alignment guard; opaque state pointer typedefs. This is the contract
  between loaded modules and the runner.
- `capability.rs` (1,180 L): post-load capability detection from exported
  symbols → `HmrCapability` (Full / Partial(state reset) / RenderOnly /
  Blocking(restart) / Invalid), `CapabilityReport`, `ExportSet`.
- `loader.rs`: `ModuleLoader` — load module from path with validation,
  ABI-version-managed compatibility, library handle liveness, load history.
- `hot_reload/v2.rs`: `HotModuleState` for the new HotApi ABI — HotApi table
  pointer + cached info, runner-owned aligned state memory, build id for
  snapshot correlation, enhanced ABI fingerprint (`AbiFingerprint`) for the
  robust SameVersion check deciding memcpy-safe state reuse.
- `legacy_module_state.rs`: legacy `ModuleState`/`AppState` shims.
- `shim.rs` (1,620 L): source-to-plugin shim generation for user C++ —
  wraps blocking main() into HMR-compatible plugin form, injects state
  serialization hooks; modes `ShimMode` (WrapMain/AddStateSerialization/
  Full/None), emits extra files as needed.
- `supervisor.rs`: crash supervision — `CrashEvent`s, `RecoveryAction`
  (HotReload/Rollback/CleanRestart/ProcessRestart/Fatal), `CrashStats`.
- `process_isolation.rs` (1,736 L): `ExecutionMode::{ProcessIsolated(default),
  InProcess}` — in-process dlopen requires explicit
  `SYNTHI_UNSAFE_INPROCESS=1` because crashes corrupt the supervisor.
- `window_backend.rs`: `WindowHandle` type-eraser — backend-specific window
  pointer stays private to its backend; `x11_window_id` exposed separately
  so GStreamer capture never needs the backend pointer across threads.
- `backends/` (6 files): `selector.rs` picks a backend via YAML `framework:`
  field or `## Language & Framework` markdown header (`SelectedBackend` with
  display name for the StatusBar pill); implementations `glfw_backend.rs`,
  `raylib_backend.rs`, `sdl2_backend.rs`, `sfml_backend.rs` — each drives its
  framework's window/event loop and exposes frames for capture (SDL2/raylib
  reference ximagesrc-compatible X11 windows); `platform/sdl_defs.rs` declares
  the SDL C symbols the runner links against.
- `path_c/` (5 files): "Path C" supervised child-process mode —
  `supervisor.rs` (`SupervisedSession`: Load/Reload/PatchBytes/SetSession/
  Shutdown command round-trips), `hmr_protocol.rs` (`HmrCommand`/`HmrResponse`
  + capability sets for supervisor/child), `ipc_transport.rs` (UDS
  send/recv helpers + socket path convention), `xvfb_allocator.rs`
  (`XvfbAllocator` leasing display numbers, e.g. `:100`).
- `gpu_runtime_boundary.rs` (3,770 L): the C ABI surface GPU modules call —
  global `GpuLaunchDispatcher` install/clear, launch generation counter,
  runtime session id, allocation identity registry, dispatch-table entry ids
  per kernel, arg classification with provenance
  (`classify_launch_args`, `arg_provenance_is_runtime_proven`),
  registered-allocation lookup, launch dim clamping/validation. This is what
  `-Wl,--export-dynamic` exposes for dlopen'd device host modules.
- `gpu_runtime_watchdog.rs`: runtime error taxonomy
  (`GpuRuntimeErrorKind`, event records, `requires_context_restart`).

---

## 5. Worker `compiler/` — Compile Request Handling (26 files)

- `context.rs`: `CompileContext` — everything a compile needs: log DC,
  terminal store, SDL input store, runner store, PC, workspace path,
  caches, orchestrator, logger, metrics, restart controller, IPC config,
  supervisor store, `XvfbAllocator`, video/audio fanouts. Doc note: session
  RTP fanouts are producers-dispatch/peers-subscribe; dropping a peer severs
  only its subscription.
- `handler.rs` (18,471 L): the monolith. `handle_compile_request`
  (L8626) is the unified entrypoint:
  1. Language dispatch — `"java"` → `java::handler::handle_java_request`.
  2. Hydrate workspace `FileRef`s (integrity-verified collab-repo/workspace
     reads) and sync request files into the workspace.
  3. HMR pipeline: ensure adapter, compute `compile_request_content_hash`
     (materialized inputs, not just primary source), purge stale split state
     for the session, detect `AdaptedProjectStatus` + sidecar split hash.
  4. `classify_loop` (rich inputs incl. prefer-deterministic-GPU-edit flag,
     effective consecutive failures) → `CompileEnrichment`.
  5. Route through AI bypass / Tier-0 fast path / diff_patch Tier-2 / full
     pipeline; for GPU manifests: device-source detection
     (`is_gpu_device_reload_marker`, `is_device_source_request`), partial
     artifact catalogs (`materialize_device_partial_artifacts`,
     `select_device_partial_artifact*` with reports), clang-AST ABI
     extraction (`clang_ast_abi_extraction*` — canonical types, record
     layouts, Itanium mangling parsing for export identity checks), fission
     publication gates (`enforce_device_hmr_publication_gates`,
     `device_hmr_fission_publication_blocker`), proof artifact writing
     (`write_device_hmr_proof_artifact`), runner runtime-control round-trips
     (`send_active_runner_runtime_command`,
     `wait_for_runner_runtime_control_ack`, device-sidecar status waits),
     warm rebuild planning (`try_warm_rebuild_header_plan`,
     `WarmRebuildDecision`), AI delta scoping (`prepare_ai_delta_device_scope`,
     acceptance/rejection reports).
  6. Emits stage-by-stage progress + diagnostics to the log DC and resolves
     with a JSON graph.
  Supporting clusters in this file: workspace file-ref hydration
  (L55–480), split sidecar handling (L615–762), edit application
  (`apply_edit_list` L764), device kernel symbol/signature extraction
  (L867–1057), launch-site mapping (source scan + boundary/runtime-object/
  native descriptors, L4452–5236), attachment instrumentation proposals
  (L5237–5393), fission candidate/evidence assembly (L5647–6095), capsule
  metadata (L6156–6311), include-policy violation checks for generated roles
  (L7447–7532), and render data structs near the tail.
- `builder.rs` (2,195 L): `BuildSession` (worker-side incremental builder:
  dependency scanning/parsing, `rebuild_parents`, `determine_rebuild_scope`,
  `incremental_compile`, widget analysis), `ParallelCompiler`
  (topologically sorted compilation units, level-grouped parallel compile),
  `WidgetDetector`/`WidgetCompiler` (extracts widget classes/functions with
  render calls + state accesses, generates widget modules + shared state
  headers), `UpdateManifest`/`UpdatePayload` wire types.
- `error_parser.rs` (1,046 L): parse raw compiler output into `Diagnostic`s
  (severity, spans, `CodeSuggestion`); `CompilerType` detection.
- `abi_version.rs` (1,651 L): `AbiVersion` semver compat
  (`is_compatible_with`, `is_breaking_from`), `SymbolInfo` + symbol manifest
  builders (required/optional).
- `source_map.rs`: address → source location resolution (DWARF-backed) for
  stack traces: `SourceLocation`, `StackFrame`, `SourceMappedTrace`.
- `serialization_utils.rs`: parse AppState int fields + defaults out of
  shared.h and generate matching serialization code.
- `plugin_contract.rs`: duplicate of runtime/plugin_contract.rs constants.
- `stages/` (12 files) — pipeline stages:
  - `compile_core.rs` / `compile_gui.rs`: compile the core/gui split modules.
  - `compile_runner.rs` (1,837 L): builds the AI-synthesized host runner;
    `CompileRunnerOptions` (AI heal allowed unless GPU sidecar-only where
    the generated runner is validation-only), `build_runner_flag_list` (pure,
    testable flag assembly); `handle_runner_execution` lives here too? — no:
    see next.
  - `runner.rs` (1,837 L): executes the built program in the runner process —
    Xvfb display management (`x11_display_num`,
    `clear_stale_x11_processes`), GStreamer pipeline construction
    (`ximagesrc display-name=… use-damage=0 ! videoscale ! videoconvert !
    <enc> ! rtpvp8pay name=video_pay ! appsink`, L785–795), structured runner
    message forwarding to DCs, lifecycle progress events, reload policy
    (`RunnerReloadPolicy`, reuse allowed?, full-device-ABI restart markers),
    post-reload crash probing, device ABI bookkeeping
    (`next_full_device_abi`, `same_session_full_device_abi_changed`).
  - `compile_device.rs` (3,423 L): CUDA/ROCm device compilation →
    `DeviceCompileOutcome` (cubin/hsaco path, post-heal source, wall-clock
    device-compiler time, diagnostics for badges + Tier-2 healer).
  - `compile_helpers.rs`: ccache-wrapped compiler spawning (cached
    availability + per-worker CCACHE_DIR to avoid cross-worker poisoning,
    `SYNTHI_CCACHE_DIR` opt-in shared cache), `system_command` base.
  - `pch.rs`: PCH construction with stdlib-header allowlist filtering.
  - `guardrails.rs` (1,031 L): user-code adapters only (main()→plugin wrap)
    — no AI-fix guardrails at this layer.
  - `ai_utils.rs` (2,499 L): AI backend call utilities; unified provider
    timeouts (raised after live Gemini observations),
    `invalidate_ai_split_cache`, hashing.
  - `gpu_runtime_contract.rs`: `render_gpu_runtime_header` — generates the C
    header declaring the runtime-boundary ABI embedded into builds.
  - `ptxas_info_parser.rs`: parses `ptxas -v` output into register-pressure /
    constant-mem / shared-mem-warning / link-error records feeding Tier-2
    triage thresholds (75 % regs, 90 % cmem).
  - `compile_core.rs`/`stages/mod.rs`: module wiring.
- `java/` (5 files): parallel Java pipeline bypassing C++ entirely —
  `input.rs` (xdotool input injection task, ≈60 fps mousemove throttle),
  `compiler.rs` (`javac` invocation + error streaming), `handler.rs`
  (top-level Java request handler: javac → JVM child; GUI apps reuse the
  Xvfb/GStreamer video pipeline), `runner.rs` (`run_java`: spawn/re-run JVM,
  HMR-substitute = kill old JVM + reuse pipeline + spawn new).

