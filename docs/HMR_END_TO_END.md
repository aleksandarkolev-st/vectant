# HMR — End-to-End

This document traces the Synthi IDE Hot Module Replacement system from a keystroke
in the editor all the way to a swapped-in `.so` running in the preview, and back —
every component, every wire format, every authoritative file path.

It is grounded in the live code in this repo as of 2026-04-28. Where a layer is
scaffolded but not authoritative in the live path, that is called out explicitly
in the section. The companion file
[HMR_CODE_AUDIT_2026-04-10.md](HMR_CODE_AUDIT_2026-04-10.md) contains the live /
partial / dormant classifications; this document focuses on how the live path
actually flows.

---

## 1. The 30-second view

```
                  ┌───────────────────┐  WS /ws (port 7070)  ┌────────────────────┐
              ┌── │   ai-gateway      │ ───────────────────▶ │   ai-engine        │
              │   │  (Node, :7070)    │   HTTP /heal/*,      │  (FastAPI :8000)   │
              │   │  WS ←→ HTTP       │   /analyze/*         │  Gemini provider   │
              │   └───────────────────┘                      └─────────▲──────────┘
              │     ▲                                                  │
              │     │ heal/* / analyze/* (frontend)                    │
              │     │                                  /refactor/{split,diff_patch,
              │     │                                   heal,heal/manifest}
              │     │                                  (worker, direct HTTP, no gateway)
┌─────────────┴───┐ │ 1. save        ┌──────────────────┐              │
│  Frontend (Web) │─┘ ──────────────▶│  collab-server   │              │
│  Monaco editor  │                  │  (Node, :1234)   │              │
└────────┬────────┘                  └─────────┬────────┘              │
         │ 2. compile request                  │ 3. fs-change broadcast│
         │    (WebRTC data channel)            │    + worker spawn     │
         ▼                                     ▼                       │
┌─────────────────┐    SDP/ICE       ┌──────────────────┐ ─────────────┘
│ signaling-server│ ◀──────────────▶ │   worker (Rust)  │  AI split / diff_patch / heal
│  (Rust, :9000)  │                  │  HMR pipeline    │
└─────────────────┘                  └─────────┬────────┘
                                               │ 4. dlopen / IPC
                                               ▼
                                     ┌──────────────────┐
                                     │ runner (Rust)    │
                                     │ Xvfb + GStreamer │
                                     │ user .so loaded  │
                                     └─────────┬────────┘
                                               │ 5. video track
                                               ▼  + status JSON
                                     ┌──────────────────┐
                                     │ Preview <video>  │
                                     │ in the browser   │
                                     └──────────────────┘
```

There are **two distinct AI paths** in HMR — they look similar and are easy to
confuse:

- **Compile-time AI** (worker → ai-engine, direct HTTP): the worker calls
  `/refactor/split`, `/refactor/diff_patch`, `/refactor/heal`,
  `/refactor/heal/manifest` to adapt user source into the 4-file split, apply
  incremental edits, or repair compile errors.
- **Runtime-error AI** (frontend → ai-gateway → ai-engine, WebSocket then
  HTTP): `RuntimeErrorInterceptor` calls `heal/ai/runtime` for healed code
  to apply to the editor, plus `heal/agentic/observability/hmr-failure` for
  agentic observability.

Both flows reach the same FastAPI process, but through different transports and
different route families. See §7.

The authoritative reload path inside the worker for compiled-language HMR is:

[compiler/handler.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs)
→ [compiler/stages/runner.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/stages/runner.rs)
→ [runtime/runner_logic.rs](../backend/synthi-webrtc-compiler/worker/src/runtime/runner_logic.rs)
→ [hmr/orchestrator.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/orchestrator.rs)

with [hmr/integration.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/integration.rs) (`HmrPipeline`)
as the per-session glue.

---

## 2. Architectural ground rules

These are invariants. If you find code that violates them, treat that as a bug, not a pattern.

1. **One worker per session.** Sessions are not multiplexed inside a single worker
   process. The collab-server spawner picks `process` / `local` (Docker) / `k8s`
   based on `SPAWNER_MODE` and `KUBERNETES_SERVICE_HOST` (see `backend/collab-server/spawner.js`).
2. **The planner is pure.** `hmr::planner::plan_reload` is a deterministic function
   over a `BuildManifest` plus a previous manifest plus rollout flags. Same inputs,
   same decision. No I/O.
3. **Adapters are dispatched through one trait.** `hmr::adapter_trait::Adapter`. The
   handler never branches on language to perform a swap — it asks the registry for
   an adapter and calls `reload()`.
4. **DynLib swaps are runner-authoritative.** The dynlib adapter's success only
   means preflight (symbol/ABI checks) passed. The actual swap happens in the
   runner via `runtime/runner_logic.rs`. This rule is enforced in
   `compiler/handler.rs` after a regression where a dynlib preflight was being
   treated as authoritative completion.
5. **Frontend never relies on browser-style HMR.** It receives JSON status events
   over a WebRTC data channel and a video stream over a media track. The runtime
   on the worker side does the actual hot reload.
6. **State is opt-in per module.** The user's compiled module exports
   `hmr_get_state_json` / `hmr_save_state_binary` (or equivalent) if it wants
   state preservation. If it doesn't, the swap is stateless and that's fine.
7. **Rollback is the default.** Every reload starts a watchdog. If health check
   fails, the previous artifact and state are restored automatically.
8. **The worker bypasses the gateway when calling AI.** Compile-time AI calls
   are direct HTTP from the worker to `AI_BACKEND_URL` (default
   `http://localhost:8000`). The gateway is only on the frontend's path. There
   is no gateway between worker and engine — adding one would break the
   worker's WSL-host-aware URL resolution and double the latency budget.

---

## 3. End-to-end walkthrough — one edit

Trace this scenario: the user has a C++ project (a small SDL2 GUI app), it's
already running in the preview, and they save a one-line change inside an
`on_update()` function.

### 3.1 Frontend: the keystroke and the save

- The editor is Monaco, hosted by the Next.js app under [synthi/](../synthi/).
- Yjs syncs the buffer through collab-server's [yjsWsServer.js](../backend/collab-server/yjsWsServer.js)
  for live collab, and Y-Sweet stores the canonical CRDT.
- On save (or autosave), `synthi/src/services/compilerClient.js` packages a
  `compile-request` and sends it on the `compile` WebRTC data channel:

  ```json
  {
    "type": "compile-request",
    "session_id": "ws-123-user-456",
    "language": "cpp",
    "source": "<full source>",
    "is_gui": true,
    "user_requested_ai": false,
    "user_requested_deterministic": false
  }
  ```

- The client also subscribes to the channel for status messages and dispatches
  them as DOM `CustomEvent`s. The HMR-relevant ones consumed by the rest of the
  frontend are:
  - `synthi:hmr-status` → [synthi/src/hooks/useHMR.js](../synthi/src/hooks/useHMR.js)
  - `synthi:compile-manifest` → status bar / diagnostics
  - `synthi:hmr-update` → [synthi/src/lib/hmr-runtime.js](../synthi/src/lib/hmr-runtime.js)

### 3.2 Signaling: how the data channel got there

- Both browser and worker had previously connected to the signaling server
  ([backend/synthi-webrtc-compiler/signaling-server/](../backend/synthi-webrtc-compiler/signaling-server/))
  and registered with the same `session_id`. Signaling is a Redis-backed WebSocket
  router, not a media or data relay.
- The signaling server brokered the SDP offer/answer + ICE exchange. After ICE
  succeeded, the data channel is peer-to-peer over SCTP/DTLS — signaling is no
  longer in the path of the compile request itself.
- Redis is required (`REDIS_URL`, default `redis://127.0.0.1:6379`); horizontal
  scaling of signaling pods uses Redis Pub/Sub to fan out across pods so peers on
  different pods can still find each other.

### 3.3 Worker entry: handler.rs

The compile request enters the worker through
[compiler/handler.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs)
(`handle_compile_request`). Java has a special early branch into
[compiler/java/handler.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/java/handler.rs);
everything else continues here.

The handler does the following, roughly in order:

1. **Loop classification.** Calls `loop_classifier::classify_loop` to decide
   whether this is **Loop A** (deterministic, AI-free, source already adapted on
   disk) or **Loop B** (AI-assisted split needed).
2. **AI gate / bypass.** Asks `hmr::ai_gate::check_ai_bypass` whether to
   `Proceed`, `UseCached`, or `FallbackDeterministic`. Only Loop B with no cache
   hit calls into the model.
3. **Source adaptation.** Either calls `compiler::stages::ai_utils::perform_ai_split`
   to produce `{ shared, core, gui }`, reads them from a cache, or falls back to
   wrapping the user source.
4. **Guardrails.** `apply_shared_guardrails`, `apply_core_guardrails`,
   `apply_gui_guardrails` enforce ABI invariants on the generated source before
   compilation (no banned globals, required hook exports, etc.).
5. **Rebuild scope.** Hashes shared/core/gui semantically and compares to the
   previous compile's hashes stored in `RunnerState`. Produces a `RebuildScope`
   from `compiler::builder`: `None`, `CoreOnly`, `GuiOnly`, `Both`, or
   `FullReload`.
6. **Compilation.** Calls `compile_core` and/or `compile_gui` per the scope. Each
   produces a `.so` artifact and an exported-symbol list parsed from `nm -D`.
7. **Build manifest.** Builds a slot-aware `BuildManifest` for the changed
   artifact set: artifact path, artifact hash, ABI version, schema hash, snapshot
   modes, capabilities, exported symbols, healthcheck strategy. Note: this used
   to always be built from the core artifact even on GUI-only edits — that bug
   is fixed; the manifest now points at the actual changed slot.
8. **Tier 0 bypass counters.** `handler.rs` keeps three atomics: `TIER0_HITS`,
   `TIER0_MISSES`, `TIER0_INELIGIBLE`. The literal-patch tier-0 path itself is
   scaffolded, but eligibility/bypass accounting is wired in at the handler.
9. **Plan + enqueue + execute.** Hands the manifest to the per-session
   `HmrPipeline` (next section).
10. **Runner execution.** Calls `compiler::stages::runner::handle_runner_execution`
    to route the artifact into the live runner.
11. **Validate or reject.** Based on the result, calls
    `pipeline.validate_active_candidate(...)` or
    `pipeline.reject_active_candidate(reason)`.

### 3.4 The HMR pipeline: integration.rs

[hmr/integration.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/integration.rs)
defines `HmrPipeline`, which is the long-lived per-preview-session object that
holds:

- `adapter_registry` — `language → Box<dyn Adapter>` (built from `AdapterMatrix`
  on session start)
- `adapter_matrix` — capability lookup table (which families support what)
- `rollout_flags` — kill switches and rollout percentages
- `ai_gate` — Loop A / Loop B gate
- `lifecycle` — `LifecycleStateMachine` for the whole session
- `telemetry` — `HmrTelemetry` aggregator
- `adapter_fsms` — per-language `AdapterLifecycleFsm` (Initialize → Ready →
  Reloading → Ready/Faulted)
- `candidate_queue` — FIFO of in-flight build candidates with supersession
- `consecutive_failures` — global failure counter for the safety valve
- `prev_manifest` — the last successful manifest for diff-based decisions

The handler calls these methods on it:

1. **`plan_reload(manifest, abi_changed, schema_changed, runtime_supports_warm)`**
   delegates to `planner_glue::execute_planner_and_transition`, which:
   - Runs the pure `planner::plan_reload(...)` to produce a `PlannerOutput`
     (`ReloadDecision` + `PlannerReasonBundle`).
   - Transitions `lifecycle` to `ReloadPlanned`.
   - Emits a `PlannerNotification` for the frontend.

2. **`enqueue_candidate(manifest, planner_output)`** checks supersession against
   the active candidate via `candidate_supersession::should_supersede`:
   - `Duplicate` → drop, do nothing.
   - `Supersede` → mark the active candidate `Discarded`, emit
     `CandidateNotification::Discarded`, enqueue the new one.
   - `LetFinish` → wait for the active to settle, do not enqueue yet.

   On enqueue, emits `CandidateNotification::Enqueued { generation, artifact_hash }`.

3. **`execute_reload(language, manifest, planner_output, reload_id)`**
   - `ensure_adapter(language)` lazily initializes the adapter and its FSM.
   - Builds an `AdapterReloadRequest`.
   - Calls `adapter.reload(&req)` → `AdapterReloadResult`.
   - Emits `AdapterStatusNotification`, possibly `AdapterHealthNotification`,
     and a `StateRestoreNotification`.

4. **`validate_active_candidate(reload_ms)` / `reject_active_candidate(reason)`**
   move the candidate through `CandidateState::HealthChecking → Validated →
   Promoted` or to `RolledBack`, emitting the matching candidate notification at
   each step.

All notifications collected during one pipeline run land in a
`PipelineNotifications` value (just `Vec<String>` of pre-serialized JSON), which
the handler ships back over the data channel.

### 3.5 Planner: planner.rs

[hmr/planner.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/planner.rs)
holds `plan_reload`, a pure function. Its decision matrix, in priority order:

1. **Kill switches** (`rollout_flags.hmr_enabled = false`, family kill, or
   forced-fallback flag) → `FullRestart`.
2. **Consecutive-failure safety valve** (`consecutive_failures >=
   threshold`) → `FullRestart`.
3. **ABI mismatch** (manifest `abi_version` differs and runtime can't tolerate
   it) → `ColdReload` or `ProcessSwap` depending on family.
4. **Schema change with no migration available** → `ColdReload`.
5. **State size over limit** → `FullRestart` (avoid OOM during transfer).
6. **Family override**: managed runtime → `ManagedReload`; process-swap family →
   `ProcessSwap`.
7. **Default**: `WarmReload` if the runtime supports it, else `ColdReload`.

The output is a `PlannerOutput` carrying:

- `decision: ReloadDecision` (`WarmReload`, `ColdReload`, `ManagedReload`,
  `ProcessSwap`, `FullRestart`, `RejectBuild`)
- `reason: PlannerReasonBundle` with `decision_reason` (human),
  `decision_code` (machine), `state_strategy`
  (`Preserve` / `Migrate` / `Reset` / `Reconstruct` / `External`),
  `fallback_strategy`, and a frontend-facing `user_message`.

For our scenario (one-line edit inside `on_update()`, ABI unchanged, schema
unchanged), the planner returns `WarmReload` + `state_strategy: Preserve`.

### 3.6 Adapter trait + registry

[adapter_trait.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/adapter_trait.rs)
defines the contract:

```rust
pub trait Adapter: Send + Sync {
    fn info(&self) -> AdapterInfo;
    fn initialize(&mut self) -> Result<(), String>;
    fn shutdown(&mut self) -> Result<(), String>;
    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult;
    fn snapshot_state(&self) -> Result<Vec<u8>, String>;
    fn restore_state(&mut self, data: &[u8]) -> Result<(), String>;
    fn healthcheck(&self) -> AdapterHealth;
    fn status_line(&self) -> String { ... }  // default impl
}
```

Request:

```rust
pub struct AdapterReloadRequest {
    pub reload_id: String,
    pub module_id: String,           // "core", "gui", etc.
    pub changed_files: Vec<String>,
    pub build_manifest: BuildManifest,
    pub preserve_state: bool,
    pub timeout_ms: u64,
}
```

Result:

```rust
pub enum AdapterReloadResult {
    Success { reload_ms: u64, state_preserved: bool },
    Failed  { error: String, recoverable: bool },
    Unsupported { reason: String },
}
```

[adapter_registry.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/adapter_registry.rs)
maps language → adapter via `create_adapter_for_language`:

| Languages              | Adapter                 | Family            | Tier |
| ---------------------- | ----------------------- | ----------------- | ---- |
| `c`, `cpp`, `rust`, `zig` | `DynLibAdapter`         | DynamicLibrary    | 3    |
| `java`, `kotlin`       | `ManagedRuntimeAdapter` (JVM)    | ManagedRuntime    | 2    |
| `csharp`               | `ManagedRuntimeAdapter` (DotNet) | ManagedRuntime    | 2    |
| `go`, `swift`          | `ProcessSwapAdapter`    | ProcessSwap       | 1    |

For our `cpp` scenario, the registry returns a `DynLibAdapter`.

### 3.7 DynLib path: the live tier-3 reload

The dynlib adapter has the most code in the repo and is the only fully
production-ready family today. Files:

- [dynlib_adapter.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_adapter.rs) — adapter shell, slot state machine
- [dynlib_swap.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_swap.rs) — actual `dlopen`/`dlclose` orchestration
- [dynlib_reload.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_reload.rs) — symbol resolution + ABI validation
- [dynlib_state_bridge.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_state_bridge.rs) — state handoff across modules
- [dynlib_abi_contract.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_abi_contract.rs) — symbol naming, version conventions
- [dynlib_preload_validator.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_preload_validator.rs) — pre-swap symbol/manifest checks
- [dynlib_crash_isolation.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_crash_isolation.rs) — watchdog
- [dynlib_rollback.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_rollback.rs) — restore old `.so` on failure
- [dynlib_symbol_resolver.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_symbol_resolver.rs) — symbol lookup helpers
- [slot_manager.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/slot_manager.rs) — dual-slot bookkeeping for atomic swap

When `DynLibAdapter::reload()` is called, it does **preflight only**: open the
new artifact via `libloading`, validate the exported symbol list against the
manifest's `exported_symbols`, validate ABI version, return success. **It does
not perform the actual swap inside the user's running program.**

That's because the `.so` is not loaded inside the worker process — it's loaded
inside the runner process (so user code can crash without taking down the
worker). So:

> A successful `DynLibAdapter::reload` is a green light, not a completed swap.
> The actual swap is runner-authoritative.

This rule is enforced in `compiler/handler.rs`. The handler then invokes
`handle_runner_execution` to push the artifact across into the runner.

### 3.8 Runner execution: stages/runner.rs

[compiler/stages/runner.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/stages/runner.rs) decides
whether to **reuse** the existing runner process or **respawn** it. Reuse is
possible only when:

- the runner is alive,
- the user's app is not a blocking CLI (`is_blocking_app == false`),
- `is_gui` matches what the runner was launched for, and
- width/height match.

If all four hold, the handler skips the restart and just streams new load
commands to the existing runner. Otherwise, the old runner is killed (Xvfb +
GStreamer + the runner binary itself) and a fresh one is spawned with the new
`DISPLAY`, `SDL_VIDEODRIVER`, etc.

### 3.9 Runtime side: runner_logic.rs

[runtime/runner_logic.rs](../backend/synthi-webrtc-compiler/worker/src/runtime/runner_logic.rs) is what
runs inside the runner process. It receives JSON commands on stdin:

```
{"cmd": "load", "module": "core", "path": "/tmp/core.so", "session_id": "..."}
{"cmd": "unload", "module": "gui"}
```

For a load on a module that is already loaded (the warm-reload case), the
sequence is:

1. **Snapshot old state.** Call the old module's `hmr_save_state_binary` (or
   `hmr_get_state_json` if binary not exported). Wrap it as a `StateSnapshot`
   with `schema_version` and `source_hash`.
2. **Load new artifact in a second slot.** `dlopen` the new `.so` without
   touching the old one yet.
3. **Resolve required symbols.** Look up `core_on_load`, `core_on_update`,
   `core_on_unload`, etc. If any required symbol is missing → fail, abort
   without touching the old slot.
4. **Atomic active-slot flip.** Single pointer assignment under the runner's
   tokio task — no lock-free juggling needed because the runner is
   single-threaded for the user's tick loop.
5. **State restore.** Call the new module's `hmr_save_state_binary(data, len)`
   passing the snapshot bytes (post-migration if schema differed). The user's
   code rehydrates whatever it cared about.
6. **First tick + healthcheck.** Run one `on_update()` (or call
   `hmr_healthcheck` if exported) under the watchdog. If it returns within
   timeout and doesn't segfault, success.
7. **Old slot cleanup.** Defer `dlclose` on the old library to the next reload
   (avoids invalidating any stale function pointers user code may have
   captured).

If step 5 or 6 fails, the runner restores the old slot from
[dynlib_rollback.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_rollback.rs) state, replays the
saved snapshot back into the old module, and reports failure to the worker.

### 3.10 Status messages back to the frontend

While all this happens, the worker emits JSON onto the WebRTC compile data
channel. Notification types serialized in
[hmr/integration.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/integration.rs):

- `adapter_status` — `AdapterStatusNotification` (family, language, health,
  reload_count, failed_reload_count, last_reload_ms, active_slot,
  state_preserved).
- `adapter_health` — `AdapterHealthNotification` (family, active, health,
  reloads, last_ms, lifecycle_state, ai_active, error).
- `state_restore_status` — `StateRestoreNotification` (restore_type, module,
  preserved_fields, reset_fields, error, fallback, strategy, duration_ms,
  warnings, lost_fields).
- `ai_status` — `AiStatusNotification` (request_id, tokens_used, estimated_cost,
  budget_used_percent, state, level, remaining).
- `candidate-notification` — `CandidateNotification::{Enqueued, Loading,
  HealthCheckStarted, HealthCheckCompleted, Promoted, RolledBack, Discarded}`.
- `hmr-status` — top-level reload decision + reason from the planner.

The frontend bridge dispatches these as `synthi:*` `CustomEvent`s and the
hooks/components ([useHMR.js](../synthi/src/hooks/useHMR.js),
[HMRStatusIndicator.jsx](../synthi/src/components/HMRStatusIndicator.jsx),
[state-restore-status.js](../synthi/src/lib/state-restore-status.js),
[adapter-status.js](../synthi/src/lib/adapter-status.js),
[adapter-health-panel.js](../synthi/src/lib/adapter-health-panel.js),
[candidate-tracker.js](../synthi/src/lib/candidate-tracker.js)) consume them.

The video stream itself never went through any of this — it's a continuous
GStreamer-encoded H.264 track on the WebRTC peer connection, tied to the same
session_id but a separate transport channel.

---

## 4. Component reference

This section is the deeper map of each subsystem. The walkthrough above is one
control-flow trace; this is the menu.

### 4.1 Compiler stages

Located at [compiler/stages/](../backend/synthi-webrtc-compiler/worker/src/compiler/stages/).

| File | Role |
| --- | --- |
| `compile_core.rs` | Compile the core slot to a `.so` (gcc/clang/rustc/zig) |
| `compile_gui.rs` | Compile the GUI slot, links against core's exported symbols |
| `compile_runner.rs` | Compile the host runner binary (one-time per session) |
| `runner.rs` | `handle_runner_execution`: decides reuse vs respawn, streams load commands |
| `ai_utils.rs` | `perform_ai_split`, `perform_ai_diff_patch` — AI-powered code adaptation |
| `guardrails.rs` | Apply ABI-shape guardrails to shared/core/gui sources before compile |
| `pch.rs` | Precompiled-header support |
| `compile_helpers.rs` | Shared helpers across stages |

### 4.2 Planner & decision

| File | Role |
| --- | --- |
| `planner.rs` | Pure `plan_reload` decision function |
| `planner_decision.rs` | `ReloadDecision`, `StateStrategy`, `FallbackStrategy`, `PlannerReasonBundle` |
| `planner_glue.rs` | `execute_planner_and_transition` — runs planner, transitions lifecycle, emits notification |
| `planner_integration_tests.rs` | Test-only |
| `dirty_classifier.rs` | File-level change classification |
| `edit_classifier.rs` | Edit-kind classification (literal-only, structural, etc.) |
| `rebuild_scope.rs` | Translate scope decisions into rebuild plans |
| `hmr_eligibility.rs` | Warmth eligibility checks |
| `scope_planner_bridge.rs` | Scope → planner glue |

### 4.3 Orchestrator + lifecycle

| File | Role |
| --- | --- |
| `orchestrator.rs` | `HmrOrchestrator` — outer coordinator owned by `CompileContext` |
| `integration.rs` | `HmrPipeline` per-session pipeline (the practical hub) |
| `lifecycle_machine.rs` | Session-level FSM: `Idle → CompileRequested → … → ReloadComplete` |
| `adapter_lifecycle_fsm.rs` | Per-adapter FSM: `Initialize → Ready → Reloading → Ready/Faulted` |
| `preview_lifecycle.rs` | High-level preview state for the UI |

### 4.4 Adapters

Trait, registry, matrix:

| File | Role |
| --- | --- |
| `adapter_trait.rs` | The `Adapter` trait |
| `adapter_registry.rs` | `create_adapter_for_language`, `AdapterRegistry` |
| `adapter_matrix.rs` | `AdapterFamily`, `CapabilityTier`, default capability matrix |

DynLib (live, tier 3, C/C++/Rust/Zig): `dynlib_*.rs` — see §3.7 for the file
list.

ManagedRuntime (partial, tier 2, Java/Kotlin/C#):

| File | Role |
| --- | --- |
| `managed_runtime_adapter.rs` | Adapter shell, JVM/CLR phase machine |
| `managed_classloader_strategy.rs` | Java classloader hot-reload approach |
| `managed_dotnet_reload.rs` | .NET assembly reload approach |
| `managed_health_probe.rs` | JVM/CLR liveness probe |
| `managed_agent_protocol.rs` | Wire format for the in-process agent |
| `managed_runtime_hooks.rs` | User-side state save/restore hooks |

Status: scaffolding is complete; the JVM/CLR host is stubbed and Java today
still routes through its own dedicated handler before reaching this generic
HMR pipeline.

ProcessSwap (partial, tier 1, Go/Swift):

| File | Role |
| --- | --- |
| `process_swap_adapter.rs` | Adapter shell, spawn/handoff phase machine |
| `process_swap_drain.rs` | Drain old child's queues before retire |
| `process_swap_handoff.rs` | IPC envelope protocol |
| `process_swap_socket_handoff.rs` | Socket-based state transfer |
| `process_swap_state_transfer.rs` | Pick transport (socket / mmap / temp file) |

Status: spawn, ready signaling, handoff, and retirement all exist as code; the
language-routing for Go/Swift in the compile pipeline is incomplete.

### 4.5 Tier 0 & fast paths

| File | Role | Status |
| --- | --- | --- |
| `tier0_literal_patch.rs` | Literal patch (string/number constants only) | Scaffolded |
| `tier0_unified.rs` | Unified tier-0 entry point | Scaffolded |
| `binary_patch/` | In-place binary diff patcher | Scaffolded |
| `diff_patcher.rs` | Source-level diff patching | Scaffolded |
| `speculative_diff_patch.rs` | Speculative patch attempt | Scaffolded |
| `fast_refresh.rs` | Boundary checks for fast refresh eligibility | Live (used by planner only) |

The handler does keep tier-0 bypass counters (`TIER0_HITS`, `TIER0_MISSES`,
`TIER0_INELIGIBLE` in `compiler/handler.rs`), so the eligibility surface is
wired even though the actual literal-patch path is not.

### 4.6 State management

| File | Role |
| --- | --- |
| `state_manager.rs` | Centralized state lifecycle owner |
| `state_serializer.rs` | Bytes ↔ values, MessagePack and JSON paths |
| `state_snapshot.rs` | `StateSnapshot { snapshot_id, schema_version, source_hash, payload }` |
| `state_diff.rs` | Field-level diffs and merges |
| `state_migration.rs` | `MigrationRegistry` for `SchemaVersion` upgrade paths |
| `state_checkpoint.rs` | Persist snapshots so a crashed reload can revert |
| `state_restore_orchestrator.rs` | `orchestrate_restore` — full restore pipeline |
| `state_restore_validator.rs` | `validate_restore` → `RestoreVerdict::{Safe, NeedsMigration, PartialRestore, Incompatible}` |
| `state_size_limiter.rs` | Cap snapshot bytes to avoid OOM |
| `state_type_id.rs` | Type-ID helpers for validation |
| `binary_state.rs` | `MsgPackState` |

### 4.7 Candidate / queue / supersession

| File | Role |
| --- | --- |
| `candidate.rs` | `Candidate` + `CandidateState` (`Built → Loading → HealthChecking → Validated → Promoted` or `RolledBack`/`Discarded`) |
| `candidate_queue.rs` | `CandidateQueue` — FIFO with one active candidate |
| `candidate_bridge.rs` | `bridge_tick` — moves candidates through states |
| `candidate_history.rs` | History for rollback and diagnostics |
| `candidate_notification.rs` | The on-the-wire candidate event enum |
| `candidate_supersession.rs` | `should_supersede` → `Duplicate` / `Supersede` / `LetFinish` |
| `candidate_watchdog.rs` | Time-out stuck candidates |
| `slot_manager.rs` | Library slot bookkeeping (used by the dynlib path) |

### 4.8 Build manifest, cache, dependency graph

| File | Role |
| --- | --- |
| `build_manifest.rs` | `BuildManifest` — per-build metadata, planner input |
| `compile_manifest.rs` | Toolchain-fingerprint enrichment |
| `incremental_cache.rs` | Per-file artifact cache (skip recompile on hash hit) |
| `cache_writer.rs` | Persist cache index to disk |
| `dependency_graph.rs` | Header includes, transitive deps |
| `compile_enrichment.rs` | Compile-context enrichment (Loop A/B, adapted, etc.) |
| `deterministic_compile.rs` | Loop A file-level scope helpers |
| `changed_files.rs` | Map fs change events to scope inputs |
| `shared_header_detect.rs` | Identify the shared header for invalidation |

### 4.9 AI assistance layer

| File | Role | Status |
| --- | --- | --- |
| `ai_gate.rs` | Loop A blocks / Loop B allows | Live |
| `ai_bypass.rs` | Cache lookup for prior splits | Live |
| `ai_cache.rs` | LRU cache of split results | Partial |
| `ai_circuit_breaker.rs` | Cool down after repeated AI failures | Partial |
| `ai_cost_tracker.rs` | Budget enforcement | Partial |
| `ai_fallback_chain.rs` | Degraded-mode chain | Partial |
| `ai_request_contract.rs` | Outgoing request validation | Partial |
| `ai_response_validator.rs` | Incoming response validation | Partial |
| `ai_timeout_guardian.rs` | Hard timeout on AI calls | Partial |
| `loop_classifier.rs` | Classify `CompileLoop` (A vs B) | Live |
| `loop_b_triggers.rs` | What forces a Loop B | Live |

Crucially: AI is **not** in the hot path. Once a project is adapted on disk,
subsequent edits stay in Loop A and never hit the model.

### 4.10 Telemetry, diagnostics, rollback, rollout

| File | Role |
| --- | --- |
| `telemetry.rs` | `HmrTelemetry` aggregator |
| `diagnostics.rs` | Helpers for diagnostic dumps |
| `health_check.rs` | `HealthCheckResult` enum |
| `rollback_notification.rs` | Wire format for rollback events |
| `swap_rollback.rs` | Orchestrate restore-old-artifact-and-state |
| `rollout_flags.rs` | `RolloutFlags` (`hmr_enabled`, family kills, percentage rollouts, failure threshold) |
| `promotion_policy.rs` | When to promote a validated candidate |

### 4.11 Reload protocol & wire format (worker ↔ runner)

| File | Role |
| --- | --- |
| `reload_manager.rs` | Reload taxonomy + snapshot bookkeeping |
| `reload_protocol.rs` | `ReloadState` machine: `Pending → AwaitingQuiescence → AwaitingSnapshot → AwaitingReadyForKill → ReadyToKill → Respawning → LoadingModule → Completed/Failed` |
| `hot_swap_coordinator.rs` | Coordinator between planner output and adapter execution |

The transport between worker and runner is JSON-over-stdio (line-delimited).
There is no HTTP between them, no shared port, no signaling-server involvement.

### 4.12 Runtime side (the running program)

| File | Role |
| --- | --- |
| `runtime/runner_logic.rs` | Authoritative load/swap/state/restore implementation inside the runner |
| `runtime/runner_bin.rs` | `runner` binary entry: Xvfb + GStreamer + tokio loop |
| `runtime/runner_state.rs` | `RunnerState` (current modules, hashes, mode, dimensions) |
| `runtime/loader.rs` | ABI validation around `dlopen` |
| `runtime/shim.rs` | IPC shim for protocol messages |
| `runtime/supervisor.rs` | Crash supervisor + watchdog inside the runner |
| `runtime/process_isolation.rs` | Sandboxing helpers |
| `runtime/capability.rs` | Runtime capability detection |
| `runtime/plugin_contract.rs` | Plugin ABI declaration shared with user `.so`s |
| `runtime/runner/{context,capture,validator}.rs` | Runner sub-modules |
| `runtime/path_c/{hmr_protocol,ipc_transport,supervisor,xvfb_allocator}.rs` | C-path runtime helpers (Xvfb allocation, IPC) |
| `runtime/hot_reload/v2.rs` | Minimal v2 protocol; live HMR orchestration is in `hmr/orchestrator.rs` |
| `runtime/backends/{glfw,raylib,sdl2,sfml}_backend.rs` | Dormant — predate the Xvfb + GStreamer rendering path |
| `runtime/window_backend.rs` | Backend selection scaffolding |

---

## 5. The collab-server side: how a save reaches the worker

The worker doesn't watch the filesystem itself. The collab-server does.

### 5.1 fsWatcherService

[backend/collab-server/fsWatcherService.js](../backend/collab-server/fsWatcherService.js) maintains one
`fs.watch` per workspace slug, debounces events ~500 ms, ignores the usual
suspects (`node_modules`, `.git`, build dirs, lock files), and broadcasts
batches over a notifications WebSocket:

```json
{ "type": "fs-change",
  "events": [ { "path": "src/main.cpp", "action": "modify" } ] }
```

It also pauses the watcher during git operations to suppress the avalanche of
events from `git pull` / `git checkout`, and supports per-path staging locks
during `git add` (TTL ~5s).

### 5.2 Spawner

[backend/collab-server/spawner.js](../backend/collab-server/spawner.js) is a thin dispatcher; the actual
work is in:

| Spawner | When | What it does |
| --- | --- | --- |
| `processWorkerSpawner.js` | Bare-metal dev, default | `cargo run --release --bin worker` as a child process |
| `localWorkerSpawner.js` | `SPAWNER_MODE=local` (docker-compose) | Docker container `synthi-worker:local` via mounted socket |
| `workspacePodSpawner.js` | `KUBERNETES_SERVICE_HOST` set | Per-session K8s pod via `@kubernetes/client-node` |

The K8s mode relies on the worker `Deployment` shipping with `replicas: 0`;
pods are created on demand per session, not held warm.

### 5.3 proxyService

[backend/collab-server/proxyService.js](../backend/collab-server/proxyService.js) HTTP-proxies select
compile-related requests to the worker for environments where the frontend
can't reach the worker directly (e.g. some local dev configurations). The
primary live path is still WebRTC; this is a fallback.

---

## 6. Frontend bridge

| File | Role |
| --- | --- |
| `synthi/src/services/compilerClient.js` | WebRTC peer + signaling + compile data channel |
| `synthi/src/hooks/useHMR.js` | React hook subscribing to `synthi:hmr-status` and friends |
| `synthi/src/components/HMRStatusIndicator.jsx` | Status pill in the UI |
| `synthi/src/lib/hmr-runtime.js` | Apply HMR updates inside the preview |
| `synthi/src/lib/state-restore-status.js` | State-restore display logic |
| `synthi/src/lib/ai-loop-status.js` | Loop A/B + AI status display |
| `synthi/src/lib/adapter-status.js` | Adapter health summary |
| `synthi/src/lib/adapter-health-panel.js` | Per-adapter health panel |
| `synthi/src/lib/candidate-tracker.js` | Candidate generation tracking |
| `synthi/src/lib/preview-store-bridge.js` | Bridge HMR events into preview state |
| `synthi/src/services/runtimeErrorInterceptor.js` | Forward runtime errors to the gateway with cooldown dedupe |
| `synthi/src/services/analyzerGatewayClient.js` | Talk to `ai-backend/gateway` for HMR-failure observability |
| `synthi/src/hooks/useRuntimeHealing.js` | Optional auto-healing flow |

The `runtimeErrorInterceptor` → `analyzerGatewayClient` path is HMR's
**observability** loop: rejected/fatal HMR cycles get reported into the
agentic AI backend so it can suggest healing edits. This is observability,
not the reload algorithm — the reload still owns its own decisions.

---

## 7. AI engine integration — both paths, end-to-end

The HMR system touches the ai-engine in two architecturally different ways.
Most of the confusion in this area comes from people assuming they're the same
path. They aren't.

```
                                     ┌────────────────────────────────────┐
                                     │   ai-engine (FastAPI :8000)        │
                                     │                                    │
        ┌── direct HTTP ──────────▶  │  /refactor/split[/verified]        │  ◀─┐
        │   (worker)                 │  /refactor/diff_patch              │    │
        │                            │  /refactor/heal                    │    │
        │                            │  /refactor/heal/manifest           │    │
        │                            │                                    │    │
        │   ┌── HTTP from gateway ─▶ │  /heal/ai/runtime                  │    │
        │   │                        │  /heal/agentic/observability/      │    │
        │   │                        │       hmr-failure                  │    │
        │   │                        └────────────────────────────────────┘    │
        │   │                                                                  │
        │   │                                  Gemini provider (factory.py     │
        │   │                                  hardcodes `return Gemini`).     │
        │   │                                  Default model env-overridable   │
        │   │                                  via `SYNTHI_GEMINI_MODEL`.      │
        │   │                                                                  │
        │   │   WS /ws (port 7070)                                             │
        │   │  ┌──────────────────┐                                            │
        │   │  │   ai-gateway     │                                            │
        │   └──┤  (Node, :7070)   │                                            │
        │      │  WS ←→ HTTP      │                                            │
        │      └────────▲─────────┘                                            │
        │               │                                                      │
        │               │ heal/ai/runtime + agentic obs                        │
        │               │                                                      │
        │     ┌─────────┴─────────┐                                            │
        │     │  Frontend         │                                            │
        │     │  RuntimeError-    │                                            │
        │     │  Interceptor.js   │                                            │
        │     │  + useRuntime-    │                                            │
        │     │    Healing.js     │                                            │
        │     └───────────────────┘                                            │
        │                                                                      │
        │     ┌───────────────────┐                                            │
        │     │  Worker (Rust)    │                                            │
        └─────┤  ai_utils.rs      │                                            │
              │  perform_ai_split │                                            │
              │  perform_ai_diff_ │                                            │
              │  patch / heal /   │                                            │
              │  try_manifest_    │                                            │
              │  heal_retry       │                                            │
              └───────────────────┘                                            │
                                                                               │
   The same Gemini-backed FastAPI process serves both paths. ──────────────────┘
```

### 7.1 Path A — compile-time AI (worker ↔ ai-engine, direct HTTP)

Source: [worker/src/compiler/stages/ai_utils.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs).

URL resolution (`get_ai_backend_url`):

1. `AI_BACKEND_URL` env var if set.
2. Otherwise, if running under WSL, the WSL host IP at `:8000`.
3. Otherwise, `http://localhost:8000`.

There is no gateway between the worker and the engine here. The single shared
HTTP timeout is `SYNTHI_AI_HTTP_TIMEOUT_SECS` (default **180s** — set this
high because live Gemini calls have been observed at ~63s on `diff_patch`,
and the previous 60s ceiling was tripping immediately after the AI had
produced a correct answer, falling all the way through to a Tier-3 full
re-split).

There are exactly four functions that call into the engine:

| Function | Endpoint | When | Returns |
| --- | --- | --- | --- |
| `perform_ai_split(req)` | `POST /refactor/split/verified` (fallback `POST /refactor/split`) | First compile or Tier-3 fallback after Loop A misses | The split JSON `{ core, gui, shared, host_runner }` plus `_synthi_architecture` and `_synthi_manifest` piggyback fields |
| `perform_ai_diff_patch(diff, core, gui, shared, host_runner, architecture)` | `POST /refactor/diff_patch` | Tier-2 incremental edit (the hot HMR path) | `Vec<Edit>` — structured edits applied locally via `hmr::edit_applier::apply_edit_list`, **not** full files |
| `perform_ai_heal(module, content, errors, shared, architecture)` | `POST /refactor/heal` | A `compile_core` / `compile_gui` invocation returned non-zero | The full healed module content as a string |
| `try_manifest_heal_retry(stderr, workspace, ...)` | `POST /refactor/heal/manifest` | Linker reports undefined references that the Phase-4.5 preflight validator missed | `Some((output, new_manifest))` — retry compile once with new manifest, write it back to the sidecar |

#### 7.1.1 The architecture cache and the sidecar

This is load-bearing and easy to break silently. Every Loop B response wraps
the LLM output as `{ result: "<json string>", architecture: "<markdown>",
manifest: { ... } }`. The architecture markdown is wrapped in a
`<synthi_arch_cache>` XML block by the Python prompt; the engine extracts it
with regex (`extract_architecture` in
[ai-backend/ai-engine/main.py](../ai-backend/ai-engine/main.py)) and surfaces
it as `architecture` on the response.

The worker stores `architecture` and `manifest` into the workspace's
`.synthi_split_meta.json` sidecar (`write_sidecar_logged` in `compiler/handler.rs`).
Subsequent `diff_patch` and `heal` calls re-inject the cached architecture as a
prompt prefix so the model does not re-derive the project's split contract on
every keystroke.

If extraction misses (the model forgot to emit the XML block, or the regex
fails), the architecture string is empty and downstream healing quality
collapses to "generic C++ assistant" without any project-specific
forbidden-pattern rules. Symptom: heal "used to work, now it's dumb" — grep
the engine logs for `synthi_arch_cache` and check the sidecar.

There is **no Anthropic / Gemini native prompt caching** in this system. The
arch-cache + manifest-cache scheme is the entire caching story. Token spend is
real on every call; the win is that responses stay short (edit lists ~100
tokens out vs full-file regeneration ~3000 tokens out).

#### 7.1.2 The compile manifest

The AI also synthesizes a `compile_manifest` (a 4-file pydantic model parsed
in [ai-backend/ai-engine/build_manifest.py](../ai-backend/ai-engine/build_manifest.py)).
That manifest is what the worker uses to build link commands — it contains the
linker libraries, include dirs, and per-slot compile flags. It is distinct
from the worker's runtime `BuildManifest` (which is per-build artifact metadata
for the planner). Two different things, same word — keep them separate.

The compile manifest is also what `/refactor/heal/manifest` corrects: when
`g++ -lSDL2 ...` reports undefined references, the worker extracts the missing
symbols (`hmr/undef_symbols.rs::extract_undefined_symbols`) and asks the AI
to update the manifest's library list. On success the new manifest is written
back to the sidecar so the next compile uses it.

#### 7.1.3 Where this fits in the HMR walkthrough

Looking back at §3 — the §3.3 handler calls `loop_classifier::classify_loop`
to decide Loop A vs Loop B. The decision tree:

- Loop A + cache hit → no AI call, reuse cached split. Default for
  subsequent edits inside an adapted project.
- Loop A + cache miss but architecture present → `perform_ai_diff_patch` (Tier 2).
- Loop B → `perform_ai_split` (Tier 3) full re-split. First compile, or after
  classify says the source has structurally changed.
- Compile fails → `perform_ai_heal` for the failing module.
- Linker fails with undefined symbols → `try_manifest_heal_retry` updates
  libraries and retries once.

All of the above run **before** the planner sees a `BuildManifest`. By the
time `pipeline.plan_reload()` is called, the source has been adapted, the
artifacts have been compiled, and the planner sees a real `.so` to swap. The
planner has no AI dependency.

### 7.2 Path B — runtime-error AI (frontend ↔ ai-gateway ↔ ai-engine)

Source:
- [synthi/src/services/runtimeErrorInterceptor.js](../synthi/src/services/runtimeErrorInterceptor.js) — singleton service that orchestrates the heal loop
- [synthi/src/hooks/useRuntimeHealing.js](../synthi/src/hooks/useRuntimeHealing.js) — React lifecycle wiring + observable state
- [synthi/src/services/analyzerGatewayClient.js](../synthi/src/services/analyzerGatewayClient.js) — WebSocket client to `ws://.../gateway/ws` (port 7070)
- [ai-backend/gateway/server.js](../ai-backend/gateway/server.js) — single WS connection per browser, dispatches `action` strings to per-action `forward*` functions
- [ai-backend/ai-engine/main.py](../ai-backend/ai-engine/main.py) — FastAPI routes

This path **does** go through the gateway, because it's the frontend talking
to the engine. Frontend → gateway is WebSocket; gateway → engine is HTTP via
`undici` to `BACKEND_URL` (default `http://127.0.0.1:8000`, in compose
`http://ai-engine:8000`).

#### 7.2.1 The trigger

`RuntimeErrorInterceptor` listens to three browser events:

| Event | Source | Reaction |
| --- | --- | --- |
| `synthi:compile-error` | The HMR pipeline (worker → frontend over WebRTC, decoded by `compilerClient.js`) | If diagnostics contain `severity: error/fatal` and auto-heal is on, schedule a heal |
| `synthi:compile-diagnostics` | Same source, alternative shape | Bridges to compile-error |
| `synthi:hmr-status` | Same source | If status is `applied` after a heal-driven retry, mark success. If `compile-error`, bridge to compile-error. If `rejected` / `fail` / `crash-fatal` / `full-reload-required`, fire the agentic observability report (see §7.2.3) |
| `synthi:request-ai-fix` | The "Fix with AI" button in the error overlay | Skip debounce, heal immediately |

Throttling guarantees:

- `MAX_HEAL_ATTEMPTS = 3` per file, then back off until `ATTEMPT_RESET_MS = 30s` of idle
- `HEAL_COOLDOWN_MS = 2000` minimum between heal attempts on the same file
- `AUTO_HEAL_DELAY_MS = 800` debounce so a single save burst that emits 5
  compile events doesn't trigger 5 heals
- `HMR_FAILURE_REPORT_COOLDOWN_MS = 5000` dedupe per `(status, filePath)` for
  agentic observability reports
- Only one in-flight healing request at a time (`_activeRequest` flag)

#### 7.2.2 The heal call

`AnalyzerGatewayClient.aiRuntimeHeal({ code, lang, filePath, diagnostics, module, autoApply })`
sends WS frame:

```json
{ "action": "heal/ai/runtime", "requestId": "<uuid>",
  "data": { "code": "...", "lang": "cpp", "filePath": "src/main.cpp",
            "diagnostics": [...], "errorOutput": null,
            "autoApply": true, "module": "core" } }
```

Gateway pipes it as `POST /heal/ai/runtime` on the engine. Response from the
engine has shape:

```json
{ "wasHealed": true,
  "healedCode": "<full file content>",
  "appliedFixes": [ { "ruleId": "...", "description": "..." } ],
  "fixCount": 1 }
```

If `wasHealed` is true, the interceptor:

1. Calls `editor.executeEdits('runtime-healing', [{ range: fullRange, text: healedCode }])`
   so the user can `Ctrl+Z` to undo.
2. After a 300ms delay, dispatches `synthi:retry-compile` to re-trigger the
   HMR pipeline.
3. Listens for the next `synthi:hmr-status` with status `applied` to confirm
   the heal succeeded; on confirmation, resets the per-file attempt counter.

If the heal fails (no `wasHealed`, gateway error, timeout), the interceptor
emits `synthi:runtime-heal-error`, surfaces the message in the overlay, and
the file's attempt counter is decremented towards the back-off threshold.

#### 7.2.3 The agentic observability hop

This is **observability only** — it does not produce a fix and does not
auto-correct anything. When HMR returns one of the irrecoverable statuses
(`rejected`, `fail`, `crash-fatal`, `full-reload-required`), the interceptor
fires `agenticRecordHmrFailure({ filePath })` which sends action
`heal/agentic/observability/hmr-failure` to the gateway, which posts to
`POST /heal/agentic/observability/hmr-failure`. The engine accumulates these
into the agentic observability store so repeated failures can later trigger
canary policies, episode replays, or supervised healing.

The `/heal/agentic/*` family in `main.py` is mostly **scaffolded** — the route
handlers exist, the episode store records arrive, but the policy-evaluation
and canary execution logic is partial. Treat this as a feedback-collection
endpoint today, not a fully closed loop. The companion observability hops
(`/heal/agentic/observability/error`, `/heal/agentic/observability/build`)
exist for parallel signals.

### 7.3 Both paths share the same engine

The Gemini provider is hardcoded in
[ai-backend/ai-engine/llm/providers/factory.py](../ai-backend/ai-engine/llm/providers/factory.py)
as a literal `return GeminiProvider()`. The `chatgpt.py` provider in the same
directory is unreachable; passing `provider_name='chatgpt'` silently still
returns Gemini.

GPU split and GPU delta deliberately use different Gemini defaults. GPU split
uses `SYNTHI_GPU_SPLIT_MODEL`, then `SYNTHI_GEMINI_MODEL`, then
`gemini-3.5-flash`. GPU delta uses `SYNTHI_GPU_DELTA_MODEL`, then
`SYNTHI_GEMINI_DELTA_MODEL`, then `gemini-3.1-flash-lite`. The old
`gemini-3.1-flash-lite-preview` name is a shutdown preview model and must only
appear in negative infrastructure-failure tests.

**Heal, split, and diff_patch choose model tier at the route handlers** in
`main.py`; the worker / gateway only pass explicit overrides for the GPU paths.
If your mental model is "flash-lite always", check the route handlers before
debugging latency.

`GEMINI_API_KEY` is required. Missing → every endpoint above raises
`ValueError`, FastAPI returns 500, gateway returns a generic error frame to
the frontend, and the user sees a generic red toast. Always check engine logs
first when AI-side anything is failing.

### 7.4 Path summary

| Concern | Path A (compile-time) | Path B (runtime-error) |
| --- | --- | --- |
| Caller | Worker (Rust) | Frontend (`RuntimeErrorInterceptor`) |
| Transport | Direct HTTP | WS to gateway → HTTP to engine |
| Endpoints | `/refactor/split[/verified]`, `/refactor/diff_patch`, `/refactor/heal`, `/refactor/heal/manifest` | `/heal/ai/runtime`, `/heal/agentic/observability/hmr-failure` |
| Trigger | Loop B / compile failure / linker undefined symbols | `synthi:compile-error`, `synthi:hmr-status: rejected\|fail\|crash-fatal`, manual "Fix with AI" |
| Architecture cache | Yes — sidecar `.synthi_split_meta.json`, re-injected per call | No — the runtime call passes raw code + diagnostics |
| Result destination | Worker filesystem (split files, healed module, updated manifest) | Monaco editor buffer (single undoable edit) → triggers another compile |
| Throttle / dedupe | Source-hash split cache, `SYNTHI_AI_HTTP_TIMEOUT_SECS` 180s | 3 attempts/file, 800ms debounce, 2s cooldown, 5s observability dedupe, single in-flight |
| Failure mode | Falls back to Tier-3 split, or surfaces compile error | Surfaces error in overlay, decrements attempt counter |
| Status | **Live** (modulo dynamic model selection nuances) | **Live** for `aiRuntimeHeal`. `/heal/agentic/*` partly scaffolded |

---

## 8. Wire formats reference

### 8.1 Frontend → worker (WebRTC data channel)

```json
{
  "type": "compile-request",
  "session_id": "<id>",
  "language": "cpp",
  "source": "...",
  "is_gui": true,
  "user_requested_ai": false,
  "user_requested_deterministic": false
}
```

### 8.2 Worker → frontend (WebRTC data channel)

```json
{ "type": "hmr-status",
  "decision": "warm_reload",
  "decision_reason": "abi compatible, schema unchanged",
  "decision_code": "WARM_RELOAD_OK",
  "user_message": "Reloading..." }

{ "type": "adapter_status",
  "adapter_family": "DynamicLibrary",
  "language": "cpp",
  "health": "healthy",
  "reload_count": 42,
  "failed_reload_count": 1,
  "last_reload_ms": 87,
  "active_slot": "core",
  "state_preserved": true }

{ "type": "state_restore_status",
  "restore_type": "full",
  "module": "core",
  "preserved_fields": ["pos_x", "pos_y", "score"],
  "reset_fields": [],
  "duration_ms": 3 }

{ "type": "candidate-notification",
  "event": "promoted",
  "preview_id": "...",
  "generation": 5,
  "artifact_hash": "..." }
```

(Field shapes match the `serde::Serialize` structs in `hmr/integration.rs`.)

### 8.3 Worker handler ↔ runner (line-delimited JSON over stdio)

```
H→R: {"cmd":"load","module":"core","path":"/tmp/core.so","session_id":"..."}
R→H: {"type":"HMR-STATUS","status":"loaded","module":"core"}
R→H: {"type":"on_update","result":true}
R→H: {"type":"healthcheck","code":0}
```

### 8.4 Browser ↔ signaling-server (WebSocket)

```
{"type":"register","role":"browser","session_id":"..."}
{"type":"sdp","sdp_type":"offer","sdp":"v=0...","session_id":"..."}
{"type":"sdp","sdp_type":"answer","sdp":"v=0...","session_id":"..."}
{"type":"candidate","candidate":{...},"session_id":"..."}
```

### 8.5 Module ABI (the user's `.so`)

A core module exports (via `extern "C"`):

```
core_on_load(AppState*)
core_on_update(AppState*) -> bool       // return true to re-render
core_on_unload()
core_get_api()                          // optional, get function table
hmr_get_state_json(buf, len)            // optional state export (text)
hmr_save_state_binary(data, len)        // optional state import (binary)
hmr_healthcheck() -> uint32             // optional, 0 = ok
```

A GUI module additionally exports:

```
gui_on_load()
gui_on_render(AppState*) -> bool
gui_on_unload()
```

The exact symbol contract lives in
[runtime/plugin_contract.rs](../backend/synthi-webrtc-compiler/worker/src/runtime/plugin_contract.rs) and is
mirrored on the HMR side in
[hmr/dynlib_abi_contract.rs](../backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_abi_contract.rs).

### 8.6 Worker → ai-engine (compile-time AI, direct HTTP)

`POST /refactor/split/verified` (request):

```json
{ "code": "<full user source>",
  "lang": "cpp",
  "mode": "split",
  "verify": true,
  "auto_repair": true }
```

`POST /refactor/split/verified` (response):

```json
{ "result": "```json\n{ \"core\": {...}, \"gui\": {...}, \"shared\": {...}, \"host_runner\": {...} }\n```",
  "architecture": "<synthi_arch_cache markdown>",
  "manifest": { "core": {...}, "gui": {...}, "shared": {...}, "host_runner": {...} },
  "lang": "cpp",
  "verified": true }
```

The worker parses `result` by finding the last `\`\`\`json` fence (LLMs often
emit explanation prose first), extracts the outermost `{...}` JSON object,
and `serde_json::from_str` it. `architecture` and `manifest` ride along as
sibling fields and get stashed into the in-memory split as `_synthi_architecture`
and `_synthi_manifest` so they round-trip into the sidecar.

`POST /refactor/diff_patch` (request):

```json
{ "diff": "<unified diff>",
  "core_content": "...",
  "gui_content": "...",
  "shared_content": "...",
  "host_runner_content": "...",
  "architecture": "<arch markdown from sidecar, or empty>" }
```

`POST /refactor/diff_patch` (response):

```json
{ "edits": [
    { "operation": "Replace",
      "module": "core",
      "anchor": "<unique anchor text>",
      "content": "<new content>" } ],
  "elapsed_seconds": 1.4 }
```

Edits are applied locally by `hmr/edit_applier.rs::apply_edit_list`, not by
having the AI return full files.

`POST /refactor/heal` (request):

```json
{ "module_name": "core",
  "module_content": "<broken source>",
  "error_messages": "<g++/rustc stderr>",
  "shared_content": "...",
  "architecture": "<arch markdown from sidecar, or empty>" }
```

`POST /refactor/heal` (response):

```json
{ "result": { "content": "<full healed module>" },
  "elapsed_seconds": 4.2 }
```

`POST /refactor/heal/manifest` (request):

```json
{ "manifest": { ... current compile manifest ... },
  "undefined_symbols": ["SDL_Init", "SDL_Quit"],
  "original_source": "...",
  "architecture": "..." }
```

Returns an updated manifest plus `unchanged: bool` (true means the AI
couldn't infer a fix; the worker must short-circuit and surface the error
card instead of looping).

### 8.7 Frontend → ai-gateway (WebSocket, port 7070, path `/ws`)

Action envelope:

```json
{ "action": "heal/ai/runtime", "requestId": "<uuid>", "data": { ... } }
```

Action `heal/ai/runtime` data:

```json
{ "code": "<current Monaco buffer>",
  "lang": "cpp",
  "filePath": "src/main.cpp",
  "diagnostics": [ { "severity": "error", "message": "...",
                     "location": { "file": "...", "line": 42 } } ],
  "errorOutput": null,
  "autoApply": true,
  "module": "core" }
```

Gateway response (one-shot):

```json
{ "type": "result", "requestId": "<uuid>",
  "data": { "wasHealed": true,
            "healedCode": "<full file content>",
            "appliedFixes": [...],
            "fixCount": 1 } }
```

Or:

```json
{ "type": "error", "requestId": "<uuid>", "message": "...", "detail": "..." }
```

Streaming responses use `{ "type": "streaming", "requestId": "<uuid>",
"chunk": ... }` for actions that opt into it (`heal/ai/stream`,
`analyze/proactive`). `heal/ai/runtime` is one-shot.

Action `heal/agentic/observability/hmr-failure` data:

```json
{ "filePath": "src/main.cpp" }
```

(The frontend client also offers `aiAnalyze`, `aiHybrid`, `aiBatch`,
`analyzeUnified`, `analyzeContainer`, etc. — they exist for the IDE's
non-HMR analysis features, not the HMR reload path.)

### 8.8 ai-gateway → ai-engine (HTTP via undici)

Each gateway action maps 1:1 to an engine route. The pattern is fixed:

```
WS frame action "heal/ai/runtime"
  → forwardAIRuntime(socket, data, requestId)
  → undici.request("POST http://ai-engine:8000/heal/ai/runtime", body=data)
  → pipe response.body back to the WS as { type: "result", requestId, data }
```

Streaming responses from the engine arrive as SSE/NDJSON; the gateway forwards
each chunk as `{ type: "streaming", requestId, chunk }`. If a new action
arrives with the same supersession key while an older one is in flight, the
gateway aborts the older request via `AbortController`. This is how "my heal
request just vanished" usually happens during rapid editing — it's intentional.

---

## 9. Failure modes and rollback

| Failure | Detected by | Response |
| --- | --- | --- |
| Compile error | `compile_core` / `compile_gui` returns non-zero | Emit `compile-error`, no reload, no state touch |
| Missing required symbol | `dynlib_preload_validator` | Adapter returns `Failed { recoverable: true }`, planner falls back, candidate `RolledBack` |
| ABI mismatch | `dynlib_abi_contract` check pre-load | Same as above, planner can escalate to `ColdReload` next time |
| `on_load` panic / segfault | Runner watchdog in `dynlib_crash_isolation` | `swap_rollback` restores old slot + state, emit `RolledBack` |
| First `on_update` returns false / hangs | Runner watchdog | Same as above |
| State too large | `state_size_limiter` | Planner returns `FullRestart` |
| State schema changed, no migration | `state_restore_validator` → `Incompatible` | Planner returns `ColdReload` with `state_strategy: Reset` |
| State partial restore | `validate_restore` → `PartialRestore` | Reload proceeds, `lost_fields` reported in `state_restore_status` |
| Repeated failures (consecutive_failures ≥ threshold) | `HmrPipeline.consecutive_failures` | Planner returns `FullRestart` (safety valve) |
| Family-wide kill switch | `RolloutFlags.family_kills` | Planner returns `FullRestart` and bypasses adapter |
| AI split timeout (verified endpoint) | `SYNTHI_AI_HTTP_TIMEOUT_SECS` (180s default) | Worker falls through to `/refactor/split` (unverified), then to deterministic wrap |
| AI diff_patch returns unparseable edits | `EditList` deserialize failure | Worker logs and falls through to Tier-3 full re-split |
| `architecture` field missing in split response | Sidecar write detects `arch=0 chars` | Subsequent diff_patch / heal use generic prompt → quality regression. Diagnostic: grep engine logs for `synthi_arch_cache` |
| `/refactor/heal/manifest` returns `unchanged: true` | `try_manifest_heal_retry` returns `None` | Worker falls through to source-level heal loop, then to error card |
| `GEMINI_API_KEY` missing | engine raises `ValueError`, returns 500 | Worker AI call fails, falls through to next tier; frontend gets generic red toast |
| `aiRuntimeHeal` returns `wasHealed: false` | `RuntimeErrorInterceptor._doHeal` | Status set to `error` with message "AI found N potential fixes but none were safe to apply" |
| Heal exceeds `MAX_HEAL_ATTEMPTS=3` per file | per-file attempt counter | Backs off until `ATTEMPT_RESET_MS=30s` of idle, ignores further compile-error events |
| Gateway supersession aborts older heal | `AbortController` on action collision | Older request rejected with `AbortError`; frontend treats as a normal failure |

Rollback is automatic. The frontend gets `state_restore_status` and
`adapter_status` events explaining what happened, and the user sees a status
indicator. Recovery options (Retry, Full Reload, Edit) are presented through
the React HMR components.

---

## 10. Live vs scaffolded — the honest summary

| Area | Status |
| --- | --- |
| Frontend ↔ worker compile request/response | **Live** |
| Signaling | **Live** |
| Collab-server file watch + spawner | **Live** |
| Compile pipeline (Loop A/B, AI split, guardrails, slot-aware manifest) | **Live** |
| Planner (`plan_reload`) | **Live** |
| `HmrPipeline` (plan / enqueue / execute) | **Live** |
| DynLib adapter + preflight + symbol validation | **Live** |
| Runner-authoritative dynlib swap with state preservation | **Live** |
| Candidate queue + supersession + notifications | **Live** |
| State snapshot / restore / migration | **Live** |
| Telemetry + adapter/state-restore notifications | **Live** |
| Rollback (crash isolation + slot restore) | **Live** |
| Compile-time AI: `/refactor/split[/verified]`, `/refactor/diff_patch`, `/refactor/heal`, `/refactor/heal/manifest` | **Live** |
| Architecture cache (`<synthi_arch_cache>` regex extraction + sidecar round-trip) | **Live** but silently degrades on regex miss |
| Compile manifest synthesis + manifest-heal retry | **Live** |
| Runtime-error AI: gateway `heal/ai/runtime` → engine `/heal/ai/runtime` | **Live** |
| Auto-apply healed code to Monaco + auto-retry compile | **Live** |
| Agentic HMR-failure observability (`/heal/agentic/observability/hmr-failure`) | **Live** as ingestion |
| Agentic policy / canary / episode logic on top of those events | **Scaffolded** — handlers present, evaluation partial |
| Managed runtime (JVM/.NET) adapter | **Scaffolded** — adapter shell exists, host stubbed, Java still goes through its own handler |
| Process-swap (Go/Swift) adapter | **Partial** — adapter logic exists, language routing into it is incomplete |
| Tier-0 literal patch / binary patch / diff patch | **Scaffolded** — eligibility counters in handler are wired, the patch path itself is not |
| Legacy `runtime/backends/{glfw,raylib,sdl2,sfml}` | **Dormant** — predates Xvfb + GStreamer rendering |
| `runtime/hot_reload/v2.rs` | **Minimal** — live HMR orchestration is in `hmr/orchestrator.rs` |

The code under `worker/src/hmr/` is real. It is also broader than the live
surface — many files are valid implementations whose product routing is
incomplete. The rule when working in there: identify the live path first
(handler → planner → integration → adapter → runner), and only edit
authority-adjacent code if you understand which side of that boundary you're on.

---

## 11. Pointers

- Companion classification doc: [HMR_CODE_AUDIT_2026-04-10.md](HMR_CODE_AUDIT_2026-04-10.md)
- Worker README: [backend/synthi-webrtc-compiler/README.md](../backend/synthi-webrtc-compiler/README.md)
- Collab-server README: [backend/collab-server/README.md](../backend/collab-server/README.md)
- ai-engine entry: [ai-backend/ai-engine/main.py](../ai-backend/ai-engine/main.py) (3700 LOC, all routes)
- ai-engine compile-manifest model: [ai-backend/ai-engine/build_manifest.py](../ai-backend/ai-engine/build_manifest.py)
- ai-engine Gemini factory: [ai-backend/ai-engine/llm/providers/factory.py](../ai-backend/ai-engine/llm/providers/factory.py)
- ai-gateway entry: [ai-backend/gateway/server.js](../ai-backend/gateway/server.js) (2700 LOC, all forwarders)
- Worker AI helpers: [backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs](../backend/synthi-webrtc-compiler/worker/src/compiler/stages/ai_utils.rs)
- Frontend healing orchestrator: [synthi/src/services/runtimeErrorInterceptor.js](../synthi/src/services/runtimeErrorInterceptor.js)
- Frontend gateway client: [synthi/src/services/analyzerGatewayClient.js](../synthi/src/services/analyzerGatewayClient.js)
- Live local wiring: [docker-compose.yml](../docker-compose.yml)
- Cluster wiring: [k8s/configmap.yaml](../k8s/configmap.yaml)
