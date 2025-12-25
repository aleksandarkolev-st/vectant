# Synthi AI‑HMR (AI Hot Module Replacement) — In‑Depth Deep Dive

> Scope of this document
>
> This is an end‑to‑end explanation of how *your* AI‑HMR pipeline works in this repo: from the Next.js editor UI, through the Rust “worker” compiler service, into the Rust “runner” process that dynamically loads hot modules, and (optionally) through the Python AI engine that performs code splitting + delta refactors.
>
> The description below is anchored to the actual modules in:
> - `backend/synthi-webrtc-compiler/worker/src/` (Rust worker + runner + HMR subsystems)
> - `ai-backend/ai-engine/` (Python AI engine)
> - `synthi/src/` (Next.js frontend HMR bridge + status UI)

---

## Table of contents

1. [What “AI‑HMR” means in Synthi](#what-aihmr-means-in-synthi)
2. [High-level architecture](#high-level-architecture)
3. [Key concepts and terms](#key-concepts-and-terms)
4. [Frontend: how code + status moves through the UI](#frontend-how-code--status-moves-through-the-ui)
5. [Worker: compile/orchestrate/reload pipeline](#worker-compileorchestrereload-pipeline)
6. [Runner: dynamic loading + independent swap domains](#runner-dynamic-loading--independent-swap-domains)
7. [State preservation: binary-first, JSON fallback](#state-preservation-binary-first-json-fallback)
8. [Fast Refresh boundary detection (Next.js-style guardrails)](#fast-refresh-boundary-detection-nextjs-style-guardrails)
9. [Crash recovery + reporting](#crash-recovery--reporting)
10. [Preemptive/speculative compilation (latency hiding)](#preemptivespeculative-compilation-latency-hiding)
11. [“AI” pieces: split + delta updates + verification + provenance](#ai-pieces-split--delta-updates--verification--provenance)
12. [Operational knobs (env vars) + debugging checklist](#operational-knobs-env-vars--debugging-checklist)

---

## What “AI‑HMR” means in Synthi

Traditional HMR for JS works because modules are interpreted and can be swapped quickly. Synthi extends the concept to **compiled native code** (C++/Rust) by making three big moves:

1. **Compile to hot-loadable dynamic libraries** (`.so`/`.dll`) on every edit.
2. **Load and swap those libraries at runtime** (via `dlopen`/`LoadLibrary`-style APIs) inside a long-running “runner” process.
3. **Preserve user-visible state across swaps** by *serializing and migrating state* (preferably via a binary MsgPack snapshot, with JSON as fallback), and by classifying reload “safety” like Next.js Fast Refresh.

The “AI” part is not just marketing: Synthi uses an AI engine to **transform code into an HMR-capable shape** (splitting “core logic” vs “GUI”, generating non-blocking hooks, incremental patching), and to **apply fast deltas** instead of full regenerations.

---

## High-level architecture

### Topology

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js Frontend (Editor + UI)                                      │
│  - compilerClient.js (WebRTC signaling + data channels)              │
│  - useHMR.js (runtime message handling + status mapping)             │
│  - HMRStatusIndicator.jsx / ErrorOverlay.jsx                         │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │
                                        │ WebRTC DataChannels
                                        │  - compile requests
                                        │  - build logs
                                        │  - terminal + GUI input
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Rust Worker (compiler + orchestrator)                               │
│  backend/synthi-webrtc-compiler/worker/src/main.rs                   │
│  - Receives CompileRequest JSON                                      │
│  - Writes sources into workspace/temp                                │
│  - Optional AI split/delta updates                                   │
│  - Differential rebuild + incremental cache                          │
│  - Starts/controls Runner process (stdin/stdout)                     │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │
                                        │ stdin commands (control)
                                        │ stdout binary stream (video frames)
                                        │ stderr logs (diagnostics)
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Rust Runner (executes modules)                                      │
│  backend/synthi-webrtc-compiler/worker/src/runner_bin.rs             │
│  - Loads .so/.dll dynamically                                        │
│  - Calls HotApi ABI (v2) and legacy symbols                          │
│  - Uses HmrOrchestrator for save/load/migration                      │
│  - Crash supervisor + recovery                                       │
└─────────────────────────────────────────────────────────────────────┘

(Optional)
┌─────────────────────────────────────────────────────────────────────┐
│  Python AI Engine (code split + delta)                               │
│  ai-backend/ai-engine/main.py                                        │
│  - /refactor/split  (full split)                                     │
│  - /refactor/delta  (fast incremental additions/deletions)           │
│  - verification + provenance + streaming                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Sequence diagram: “edit → HMR applied”

```mermaid
sequenceDiagram
  autonumber
  participant UI as Next.js UI
  participant CC as compilerClient.js
  participant W as Rust Worker (main.rs)
  participant R as Rust Runner (runner_bin.rs)
  participant AI as Python AI Engine (optional)

  UI->>CC: user edits + clicks Run/Compile
  CC->>W: CompileRequest over WebRTC DataChannel
  alt use_ai_split enabled
    W->>AI: POST /refactor/split or /refactor/delta
    AI-->>W: split/delta JSON payload
  end
  W->>W: hash compare + rebuild scope
  W->>W: compile (incremental cache, parallel compile)
  W->>R: stdin: load/reload module paths
  R->>R: save state (binary preferred)
  R->>R: dlopen new lib; migrate state; swap function tables
  R-->>W: stderr: status JSON (hmr-status)
  W-->>CC: buildLogChannel: status JSON
  CC-->>UI: dispatch synthi:hmr-status
  UI-->>UI: HMRStatusIndicator updates
```

---

## Key concepts and terms

### Worker vs Runner

- **Worker** (`worker/src/main.rs`) is the network-facing compiler/orchestrator:
  - Receives compile requests.
  - Optionally calls AI split/delta.
  - Compiles modules.
  - Manages a long-running Runner process.

- **Runner** (`worker/src/runner_bin.rs`) is the long-running runtime:
  - Loads hot modules as dynamic libraries.
  - Executes them in a loop.
  - Performs state save/load/migration on reload.

### Modules and slots

Synthi can run in multiple “layouts” depending on what code is generated:

- **Split mode**: separate `core` and `gui` modules (`core.so` / `gui.so`).
- **Legacy/main mode**: a single `main` module.
- **Widget-level HMR** (component-level): multiple `widget_*.so` modules (detected/compiled by the worker).

The “slot” concept is represented by `ModuleSlot` in:
- `backend/synthi-webrtc-compiler/worker/src/plugin_contract.rs`

### ABI: v2 HotApi (single export)

The modern path is **ABI v2** (`HOT_API_VERSION = 2`), defined in:
- `backend/synthi-webrtc-compiler/worker/src/plugin_contract.rs`

Key properties:
- The module exports **one symbol**: `hot_get_api()` returning a pointer to a static `HotApi` table.
- State is **owned/allocated by the runner** (not by the module) with explicit size + alignment.
- Migration never casts old state pointers; it consumes **serialized snapshots**.

This is why Synthi can do safe-ish HMR even for native code: the ABI is designed for hot-swapping.

---

## Frontend: how code + status moves through the UI

### WebRTC connection + DataChannels

The frontend bridge lives in:
- `synthi/src/services/compilerClient.js`

It establishes a `RTCPeerConnection`, negotiates via WebSocket signaling, then uses DataChannels for:
- compile requests
- build logs
- terminal stdin
- GUI events

The important behavior for AI‑HMR is: **anything that looks like HMR status is parsed and re-dispatched as browser events**.

### Status propagation

`compilerClient.js` parses incoming messages and dispatches:
- `synthi:hmr-update` for module update payloads
- `synthi:hmr-status` for status objects (`applied`, `rejected`, `compile-error`, etc.)
- `synthi:compile-diagnostics` for structured compile diagnostics

Then:
- `synthi/src/hooks/useHMR.js` listens for `synthi:hmr-update` and translates status into UI-friendly states.
- `synthi/src/components/HMRStatusIndicator.jsx` listens for `synthi:hmr-status` and shows a compact “Next.js-like” dot + message.
- `synthi/src/components/ErrorOverlay.jsx` can show compile errors and runtime crash info.

**Important detail:** the UI does *not* implement the HMR algorithm. It is a status/rendering layer.
The algorithm runs in Rust.

---

## Worker: compile/orchestrate/reload pipeline

The Rust worker is centered in:
- `backend/synthi-webrtc-compiler/worker/src/main.rs`

This section is intentionally **implementation-level**. The worker is the part of Synthi that turns “a user edit” into:

1) a concrete on-disk workspace, 2) compiled dynamic libraries, 3) a decision about whether hot reload is safe, and 4) a stream of status/diagnostics events back to the UI.

### Worker mental model: session-scoped control plane

The worker is not “just a compiler”. It is the **control plane** for a long-lived session:

- It owns the WebRTC connection and DataChannels.
- It owns (and usually keeps alive) a **Runner child process**.
- It owns compilation caches and rebuild classification state.
- It owns the per-session Fast Refresh boundary checker.

The internal state model for that is visible in `main.rs` as `RunnerState` (even where some code paths still use individual fields directly). It tracks:

- Runner process + stdin handle
- whether the session is GUI vs non-GUI (`is_gui`, `width`, `height`)
- whether the runner is HMR-capable (`is_hmr_capable`, `hmr_capability`)
- module hashes (`module_hashes`) and loaded module paths (`loaded_core_path`, `loaded_gui_path`)
- widget-level tracking (`loaded_widget_paths`, `widget_hashes`)
- GUI streaming components (GStreamer pipeline, WebRTC media tracks)

### Worker startup constraints: tool availability

The worker bakes in “this environment must have these tools” lists:

- `REQUIRED_TOOLS`: `g++`, `rustc`, `tsc`, `clangd`
- `GUI_TOOLS`: `xdotool`, `Xvfb`, `matchbox-window-manager`

When something looks like a flaky HMR pipeline, it’s often just missing toolchain prerequisites.

### 1) Receive CompileRequest

The worker receives a JSON request (deserialized into `CompileRequest`) that includes:
- language
- filename + `source`
- `files[]` (additional files)
- `is_gui`, width/height
- `use_ai_split`

#### What the worker treats as “the truth”

`CompileRequest` is the truth. The worker does not compile “whatever is in the repo folder”; it compiles the exact payload it was sent.

Two details from the real struct in `main.rs` that matter in practice:

- `session_id` is optional, but when present it allows the worker to associate compiles with a long-lived runner instance.
- `supports_h265` can influence media pipeline decisions for GUI streaming.

The worker also supports streaming build logs + structured status through channels that end up in `compilerClient.js`.

### 2) Decide whether the session is HMR-capable

In `handle_compile` the worker checks:
- whether the incoming code already has hook-like exports (e.g., `on_update` / `on_load`), or
- whether `use_ai_split` is enabled.

It also auto-enables AI split when reusing an already HMR-capable GUI runner:
- if a previous run was AI-split and the runner is still alive, subsequent saves should keep using the AI split path.

This prevents a common failure mode:
- first run uses AI split → runner becomes HMR-capable
- second compile sends raw blocking code → runner can’t hot reload it

#### Why “capability” exists at all

Native HMR is only possible if the produced library exports the expected hook surface.

The worker uses `detect_capabilities(...)` and then reports a user-facing `hmr-status` event (via `capability::HmrStatus`) so the UI can show “HMR is armed” vs “HMR is not possible; restart required”.

### 3) AI split / delta updates (optional)

If enabled, the worker calls the AI backend to *produce HMR-friendly modules*.

This logic is in `perform_ai_split` in `main.rs`.

**Four-level cache strategy (“Next.js-like”):**

- **Level 1: exact source hash** → instant cache hit.
- **Level 2: structural hash** (strings/comments/numbers normalized) → patch strings locally.
- **Level 2.5–2.8: semantic/structural deltas** → call fast delta endpoints and inject into cached result.
- **Level 3: full regeneration** → call `/refactor/split` for a full AI split.

The worker uses `AI_BACKEND_URL` (defaulting to a WSL-ish IP in this repo) and calls endpoints such as:
- `/refactor/split` (full split)
- `/refactor/delta` (fast incremental additions/deletions)

#### What “Level 2.5–2.8” really means in code

Inside `perform_ai_split` you can see multiple *distinct* “fast paths” that try to avoid full regeneration:

- **String-only edits**: structural hash matches → patch string literals in the cached split output locally.
- **Local deletion patch**: detect removed lines and attempt a purely local patch before asking the AI.
- **Delta deletion**: call `/refactor/delta` with `update_type="deletion"` when local deletion patch fails.
- **Structural addition**: treat “new element/button” as a delta-addition case and call `/refactor/delta`.
- **GUI modification**: treat “position/color/size change” as a delta-modification case and call `/refactor/delta`.
- **Semantic change on structural match**: if the structure matches but semantic hash changed, it tries an incremental AI update.

The critical property is: **the worker tries very hard to keep the runner alive** and just swap modules.

### 4) Differential rebuild: only compile what changed

The worker computes hashes and rebuild scope via `builder.rs`:
- `ModuleHashes`
- semantic hashing for shared headers
- `RebuildScope` (e.g., `GuiOnly`, `CoreOnly`, `Both`, `FullReload`)

Conceptually:
- if the shared header changed → rebuild both
- if only GUI changed → rebuild GUI and preserve core state
- if core changed → rebuild core; may require GUI reload if ABI/core API changes

#### File change classification (watcher + rebuild scope)

On the “watch mode” path, file changes are coalesced and classified in `backend/synthi-webrtc-compiler/worker/src/watcher.rs`:

- `shared.h/shared.hpp` → rebuild both
- filenames containing `core` + code extension → core change
- filenames containing `gui` + code extension → gui change
- other `*.c/*.cpp/*.rs` → main change

This classification drives the `scope` string the watcher emits and the worker uses to choose a rebuild plan.

### 5) Incremental compilation cache (ccache-like)

`incremental_cache.rs` implements a content-addressable object cache:
- key is a hash of source + flags + headers content
- supports toolchain-aware invalidation (`ToolchainInfo`)
- validates cached artifacts with CRC32
- LRU/size-based cleanup (default 100MB)

This is distinct from “AI split cache”:
- AI split cache avoids re-calling the LLM.
- Incremental compilation cache avoids recompiling identical translation units.

#### Why cache hits can be “surprisingly strict”

The incremental cache is intentionally conservative. In `incremental_cache.rs` the cache entry includes:

- `source_hash`
- `flags_hash`
- `headers_hash` (hash of header *content*, not just header paths)
- `toolchain: ToolchainInfo` (compiler version, target triple, optimization/debug/PIC/LTO, environment hash)
- `checksum` (CRC32 integrity check)

So a cache hit requires not only identical source but a compatible toolchain and header content.

### 6) Parallel compilation

`builder.rs` includes `ParallelCompiler`:
- builds a dependency graph of compilation units
- compiles independent units in parallel (bounded by CPU cores)

This is how Synthi attempts to keep “save-to-HMR” latency low even with multi-file outputs.

### 7) Guardrails + auto-shim (convert blocking code into HMR-capable hooks)

The worker contains logic (module `shim.rs` + in-worker transformations) to turn blocking `main()` loops into a structure the runner can tick:

- detect shim mode
- generate an `on_update` loop
- ensure the hot module yields control so the runner can keep running while recompiles happen

This is critical because native code frequently has `while(true)` loops that would otherwise prevent swapping.

### 7.5) Worker-side Fast Refresh boundary checks (veto unsafe reloads)

The worker runs Fast Refresh boundary checks during the compile/reload pipeline and emits frontend events *before* asking the runner to swap.

In `main.rs` you can see a per-session `BoundaryChecker` stored behind an `Arc<Mutex<...>>`.

When a boundary check fails, the worker sends a `hmr-status` message with:

- `type: "hmr-status"`
- `status: "boundary-violation"`
- the relevant module (`core` or `gui`)
- a structured payload (from `BoundaryViolationEvent::from_check(...)`)

If the recommended `RefreshAction` implies escalation (like full reload), the worker also emits an explicit “rejected/full reload required” status so the UI can guide the user.

### 8) Spawn / control the Runner

The worker keeps a long-lived “runner process” and communicates via:
- stdin commands (control plane)
- stdout raw frame bytes (video)
- stderr logs (status and diagnostics)

The Runner is what actually loads `.so/.dll` and applies hot swaps.

#### Worker → runner control plane

The worker controls the runner via stdin commands. The runner has a dedicated stdin reader thread and treats stdin as its command bus.

This design is why HMR can be reliable cross-platform:

- stdin is always available
- commands are serialized text
- runner does not need WebRTC/network dependencies

#### Worker → frontend status plane

The worker also emits structured JSON status back to the frontend. You can see explicit emission of `"type": "hmr-status"` in `main.rs` for cases like:

- compile errors (`compile-error`)
- rejected reloads (“keeping previous module”)
- capability detection reports
- boundary violations

That’s what `compilerClient.js` re-dispatches as `synthi:hmr-status` in the browser.

---

## Runner: dynamic loading + independent swap domains

The runner entrypoint is:
- `backend/synthi-webrtc-compiler/worker/src/runner_bin.rs`

### Control plane: stdin command reader

Runner spawns a dedicated thread that reads stdin line-by-line and forwards commands to the main thread via a channel.

That’s why the worker can do things like:
- set session id
- load core/gui modules
- push synthetic input events
- request reloads

### Independent swap domains

Runner tracks state per module in `module_states: HashMap<String, ModuleState>`.

This enables:

1. **Reload GUI without touching core state**
2. **Reload core and then reload GUI if the core API/ABI drifted**
3. **Only migrate the state for the module you actually swapped**

This mirrors “component-level” reasoning from Next.js: you try to reload the smallest safe unit.

### Two ABI paths: legacy vs HotApi v2

Runner supports:

- **Legacy symbol-based ABI** (multiple exports like `core_on_load`, `core_on_save_state`, etc.)
- **HotApi v2** (single export `hot_get_api` returning function pointers + metadata)

HotApi v2 is defined in `plugin_contract.rs` and used by:
- `runner_bin.rs` (validation, state allocation, hot_reload_v2)

The v2 design reduces ABI fragility because the runner drives allocation and versioning.

### HMR Orchestrator integration

Runner instantiates `HmrOrchestrator`:
- `backend/synthi-webrtc-compiler/worker/src/hmr_orchestrator.rs`

The orchestrator centralizes:
- reload classification (`ReloadClassifier`)
- snapshotting (`SnapshotManager`)
- crash policies (`CrashSupervisor`)
- ABI validation (`ModuleLoader`, optional)
- state migration (binary-first, JSON fallback)

Even when runner has custom reload logic (e.g., HotApi v2), the orchestrator provides shared primitives: save/load, schema compatibility checks, and migration summaries.

---

## State preservation: binary-first, JSON fallback

Synthi treats state preservation as a first-class, explicit pipeline.

### The three core operations

1. **Save state from the old module**
2. **Load the new module**
3. **Restore/migrate state into the new module**

The orchestrator provides helpers that work directly with `libloading::Library`:

- `save_module_state(slot, lib, state_ptr) -> SavedState`
  - tries `*_on_save_state_binary` first
  - falls back to `*_on_save_state` (JSON)

- `load_module_state(slot, new_lib, saved, template_json) -> LoadedState`
  - tries `*_on_load_from_binary`
  - falls back to JSON load (`*_on_load_from_json`), optionally applying a JSON diff/migration first

These live in:
- `backend/synthi-webrtc-compiler/worker/src/hmr_orchestrator.rs`

### Binary state: MsgPack snapshots

Binary state is built around:
- `backend/synthi-webrtc-compiler/worker/src/binary_state.rs`
- `backend/synthi-webrtc-compiler/worker/src/state_manager.rs`

The idea:
- serialized snapshots are opaque bytes
- migrations are schema-aware
- performance is much better than parsing JSON

### JSON state: field-level diff and merge

When binary is unavailable, Synthi uses JSON and performs a *field-level merge*:

- Compute a “template” JSON for the new version (fields list)
- Diff old JSON vs new template
- Preserve user-visible fields based on rules

Rules are configurable per slot via `DiffConfig` in:
- `backend/synthi-webrtc-compiler/worker/src/state_diff.rs`

Example policies:
- Core preserves `x`, `y`, `dx`, `dy`, `running`, `paused`, and button geometry fields.
- GUI resets transient UI fields like `animation_frame` and `hover_state`.

This is how Synthi achieves the “my app didn’t reset when I changed the code” experience.

### Schema compatibility checks

To avoid unsafe pointer reuse, the orchestrator can compare schema hashes between old and new libs via:
- `*_get_state_schema_hash()` (slot-specific symbol names)

This produces a `SchemaCompatibility` classification:
- Compatible
- Incompatible
- Missing hash cases

This is used to decide whether a “warm” swap is possible vs a “cold reload” (re-init).

---

## Fast Refresh boundary detection (Next.js-style guardrails)

Fast Refresh in JS has a key idea: some edits are safe to hot-swap, others must trigger a full reload.

Synthi ports that concept to native code via `BoundaryChecker` in:
- `backend/synthi-webrtc-compiler/worker/src/fast_refresh.rs`

### What it checks

The boundary checker analyzes source to detect:
- state struct layout changes (fields added/removed)
- function signature changes
- ABI mismatches
- core API changes (forcing GUI reload)
- global state mutation patterns
- new dependencies

It emits a `BoundaryCheckResult` with:
- `violations[]`
- recommended action: `HotReload`, `ReloadGui`, `FullReload`, `Restart`, etc.

These events are surfaced to the frontend as `boundary-violation` status, which is displayed by `HMRStatusIndicator`.

### Boundary violation types

```rust
pub enum BoundaryViolation {
    /// State struct layout changed (fields added/removed/reordered)
    StateLayoutChanged { module, old_fields, new_fields },
    
    /// Function signature changed (can't hot-swap)
    SignatureChanged { function, old_signature, new_signature },
    
    /// Non-component export added (e.g., global function that's not a hook)
    NonComponentExport { export_name, reason },
    
    /// Global state was mutated outside of proper hooks
    GlobalStateMutation { variable, location },
    
    /// ABI version mismatch between modules
    AbiMismatch { module, expected, found },
    
    /// CoreAPI changed (GUI must reload)
    CoreApiChanged { changed_functions },
    
    /// Module removed (can't hot-remove)
    ModuleRemoved { module },
    
    /// New required dependency added
    NewDependency { module, dependency },
}
```

Each violation has:
- `message()`: Human-readable explanation
- `is_fatal()`: Whether this blocks HMR entirely
- `requires_full_reload()`: Whether a full reload is needed

### Module analysis

The checker performs **source-level static analysis**:

```rust
pub struct ModuleAnalysis {
    pub functions: HashMap<String, FunctionSignature>,
    pub state_structs: HashMap<String, StateStructInfo>,
    pub exports: HashSet<String>,
    pub global_vars: HashSet<String>,
    pub dependencies: HashSet<String>,
    pub abi_version: Option<u32>,
}
```

It compares the new analysis against the previous baseline to detect changes.

### Refresh action determination

The checker determines the recommended action based on violation severity:

| Violations | Action |
|------------|--------|
| None | `HotReload` |
| Fatal violations | `FullReload` |
| CoreAPI changed | `ReloadGui` |
| Non-fatal violations | `HotReloadWithWarnings` |

Lifecycle hooks that are recognized (exempt from non-component export warnings):
- `on_load`, `on_update`, `on_unload`, `on_event`, `on_render`
- `on_save_state`, `on_load_from_json`
- `core_*` and `gui_*` prefixed equivalents
- `entrypoint`, `main`

---

## Crash recovery + reporting

Native code can segfault. Synthi attempts to recover without killing the entire developer session.

### Crash handlers

Crash recovery utilities are in:
- `backend/synthi-webrtc-compiler/worker/src/crash_recovery.rs`

Runner installs crash handlers and uses protective execution wrappers so:
- a crashing module can be detected
- the system can roll back to the last known good module or keep the old module running

### Crash supervisor policies

`CrashSupervisor` and `SupervisorConfig` live in:
- `backend/synthi-webrtc-compiler/worker/src/supervisor.rs`

Runner enables the crash supervisor by default in this repo and uses policies like:
- max 3 consecutive crashes within a time window
- first crash: try hot reload or keep old module
- repeated crashes: escalate to rollback / restart requirement

### Source mapping

Crash display is improved with source map resolution:
- `backend/synthi-webrtc-compiler/worker/src/source_map.rs`

Frontend can show crash details via:
- `synthi/src/components/ErrorOverlay.jsx`

---

## Preemptive/speculative compilation (latency hiding)

To make “save → update” feel instant, the worker can start compiling before you fully stop typing.

This is implemented in:
- `backend/synthi-webrtc-compiler/worker/src/watcher.rs`

Key ideas:

- A standard debounce (`DEBOUNCE_MS = 300`) prevents compiling on every keystroke.
- A speculative debounce (`SPECULATIVE_DEBOUNCE_MS = 150`) can start **speculative compilation**.
- Burst typing detection avoids thrashing: speculative compiles are suppressed during rapid changes.
- Speculative compiles can be cancelled if new changes arrive (shared cancellation flag).

This is a compiler-side analogue of “preparing” updates while the developer is still typing.

---

## AI pieces: split + delta updates + verification + provenance

The AI engine is a FastAPI service in:
- `ai-backend/ai-engine/main.py`

### Endpoints used by AI-HMR

- `/refactor/split` — full split into HMR-capable modules (core/gui + shared headers, etc.)
- `/refactor/delta` — incremental updates (additions/deletions) that can be injected into cached split outputs

The worker chooses which endpoint to call based on cache hits and change classification.

### Streaming

The engine supports real token streaming with provider adapters in:
- `ai-backend/ai-engine/streaming.py`

This is used for responsiveness (UI can show partial progress), even when the final split takes longer.

### Verification (hard gate)

AI outputs can be wrong. The verifier enforces invariants before the worker consumes outputs:
- `ai-backend/ai-engine/verifier.py`

Examples of invariants:
- missing required exports/symbols
- invalid structure
- ABI mismatch
- incomplete/truncated output

Verification can also perform **capped auto-repair** (strict bounds in production).

### Provenance

Every AI call can be tracked for debugging and traceability:
- `ai-backend/ai-engine/provenance.py`

This captures:
- prompt hash
- model used
- output hash
- verifier results
- session id

This is useful when an AI-generated split causes a runtime crash: you can correlate the crash with the AI change record.

### Job queue + budgeting

The AI engine includes a priority job queue:
- `ai-backend/ai-engine/job_queue.py`

It supports:
- per-request budgets (time/tokens)
- priorities (interactive vs background)
- queue aging (avoid starvation)

This matters for AI‑HMR because you want delta updates (interactive) to preempt slower full refactors.

---

## Operational knobs (env vars) + debugging checklist

### Important environment variables

- `NEXT_PUBLIC_COMPILE_SIGNAL_URL` — frontend WebSocket signaling URL (default `ws://localhost:9000`)
- `NEXT_PUBLIC_ICE_SERVERS` — JSON list of ICE servers for WebRTC
- `AI_BACKEND_URL` — where the worker calls the AI engine (split/delta)

Runner/worker feature flags (examples used in the code):
- `SYNTHI_LOADER_VALIDATION` — enable ABI validation via `ModuleLoader`
- `SYNTHI_CRASH_SUPERVISOR` — crash supervisor toggle (currently enabled by default in code)

### Debugging checklist

If “HMR didn’t apply”, the fastest way to isolate is to follow the pipeline:

1. **UI → Worker**
   - Is `CompilerClient` connected (`connected` state)?
   - Are you seeing compile requests logged in worker?

2. **AI split stage (if enabled)**
   - Did the worker log `[AI Split] Cache HIT/MISS`?
   - Did it call `/refactor/delta` or `/refactor/split`?

3. **Compile stage**
   - Do you see `compile-diagnostics` events in the UI?
   - Are object cache hits happening (`incremental_cache` logs)?

4. **Runner stage**
   - Is the runner still alive (heartbeat logs)?
   - Did it receive stdin commands (`Stdin received:` logs)?

5. **Reload stage**
   - Do you see `hmr-status` events (applied/rejected/crash-recovered)?
   - If rejected, check boundary violations or schema incompatibility.

6. **Crash stage**
   - If crash recovered, inspect crash reports + source mapping.
   - If crash fatal, it’s usually repeated crashes within the supervisor window.

---
---

## HMR Orchestrator: central coordination

The HMR Orchestrator (`hmr_orchestrator.rs`) is the **unified integration module** that ties together all HMR subsystems:

```rust
pub struct HmrOrchestrator {
    // Core subsystems
    state_manager: StateManager,
    module_loader: ModuleLoader,
    crash_supervisor: CrashSupervisor,
    reload_classifier: ReloadClassifier,
    snapshot_manager: SnapshotManager,
    task_registry: AsyncTaskRegistry,
    
    // Fast Refresh boundary checking
    boundary_checker: BoundaryChecker,
    
    // Boundary management
    boundary_manifests: HashMap<ModuleSlot, BoundaryManifest>,
    active_boundaries: HashMap<BoundaryId, Boundary>,
    
    // Configuration and statistics
    config: OrchestratorConfig,
    stats: OrchestratorStats,
}
```

### Orchestrator configuration

```rust
pub struct OrchestratorConfig {
    pub prefer_binary_state: bool,        // Default: true
    pub max_snapshots: usize,             // Default: 10
    pub max_consecutive_crashes: u32,     // Default: 3
    pub task_shutdown_timeout: Duration,  // Default: 5s
    pub strict_abi: bool,                 // Default: false
    pub max_boundaries_per_module: usize, // Default: 20
}
```

### Hot reload pipeline

The orchestrator's `hot_reload()` method implements an **8-step pipeline**:

1. **Classify reload** using `ReloadClassifier` with context (boundary ID, file path)
2. **Create pre-reload snapshot** (if Warm or Cold reload)
3. **Enter crash supervisor context** for crash attribution
4. **Drain async tasks** (for Cold reloads only)
5. **Validate ABI** (if strict mode enabled)
6. **Migrate state** (prefer binary/MsgPack over JSON)
7. **Handle migration result** and update statistics
8. **Log status** and return `HmrResult`

### Result types

```rust
pub struct HmrResult {
    pub success: bool,
    pub reload_class: ReloadClass,
    pub module: ModuleSlot,
    pub preserved_fields: Vec<String>,
    pub reset_fields: Vec<String>,
    pub new_fields: Vec<String>,
    pub duration_ms: u64,
    pub used_binary_serialization: bool,
    pub snapshot_id: Option<u64>,
    pub error: Option<String>,
    pub recovery_action: Option<RecoveryAction>,
}

pub struct HmrStatus {  // For frontend reporting
    pub status: String,  // "hmr_success" or "hmr_failed"
    pub module: String,
    pub reload_class: String,
    pub preserved_fields: Vec<String>,
    pub new_fields: Vec<String>,
    pub duration_ms: u64,
    pub binary_state: bool,
    pub crash_count: u64,
    pub snapshot_available: bool,
}
```

### Schema compatibility checking

```rust
pub enum SchemaCompatibility {
    Compatible { hash: u64 },
    Incompatible { old_hash: u64, new_hash: u64 },
    NewMissing { old_hash: u64 },
    OldMissing { new_hash: u64 },
    NeitherHasHash,
}
```

- **Compatible**: Safe to reuse state pointer
- **Incompatible/NewMissing**: Requires cold reload

### Library-based state operations

The orchestrator provides helpers that work directly with `libloading::Library`:

```rust
pub struct SavedState {
    pub binary: Option<Vec<u8>>,
    pub json: Option<String>,
    pub was_binary: bool,
    pub module: ModuleSlot,
}

pub struct LoadedState {
    pub state_ptr: *mut c_void,
    pub was_binary: bool,
    pub migration_result: Option<MigrationSummary>,
}

pub struct MigrationSummary {
    pub preserved_fields: Vec<String>,
    pub reset_fields: Vec<String>,
    pub new_fields: Vec<String>,
}
```

### Statistics tracking

```rust
pub struct OrchestratorStats {
    pub total_reloads: u64,
    pub successful_reloads: u64,
    pub failed_reloads: u64,
    pub binary_migrations: u64,
    pub json_migrations: u64,
    pub snapshots_created: u64,
    pub snapshots_reverted: u64,
    pub crashes_recovered: u64,
    pub total_preserved_fields: u64,
}
```

---

## Additional implementation details

### Reload class taxonomy

The reload manager (`reload_manager.rs`) implements a **four-tier reload classification system** that determines strategy and guardrails:

```rust
pub enum ReloadClass {
    /// SAFE RELOAD - Stateless, no side effects, instant
    /// - Pure function changes, constants, comments
    /// - Target latency: <10ms
    Safe,
    
    /// WARM RELOAD - State preserved, minimal disruption
    /// - State schema unchanged, API signatures stable
    /// - Target latency: <100ms
    Warm,
    
    /// COLD RELOAD - Full restart, state reset
    /// - Breaking API changes, incompatible state schema
    /// - Target latency: <1000ms
    Cold,
    
    /// CANARY RELOAD - Shadow execution for testing
    /// - Compare outputs without serving from new code
    Canary,
}
```

Each class has distinct behaviors:

| Class | Max Latency | Semantic Tests | Drain Requests | Task Shutdown | Snapshot |
|-------|-------------|----------------|----------------|---------------|----------|
| Safe | 10ms | No | No | No | No |
| Warm | 100ms | Yes | No | No | Yes |
| Cold | 1000ms | Yes | Yes | Yes | Yes |
| Canary | 5000ms | Yes | No | No | No |

#### Automatic classification

The `ReloadClassifier` automatically determines reload class based on detected changes:

- **Cold triggers:** breaking API changes, state schema changes, removed exports
- **Safe triggers:** stateless changes with no added exports and no API function modifications
- **Default:** Warm (when uncertain)

Manual overrides are available at three priority levels:
1. **Global override** (debugging only, disables safety checks)
2. **Boundary-specific override** (per-boundary `BoundaryId`)
3. **Path pattern override** (glob matching like `**/*_test.rs`)

### Sub-module boundary system

The boundary system (`boundary.rs`) enables **finer-grained HMR** by dividing modules into explicit sub-boundaries:

```rust
pub enum BoundaryType {
    CoreLogic,   // State and computation
    CoreApi,     // Exposed functions
    GuiRender,   // Rendering code
    GuiEvents,   // Event handling
    GuiState,    // GUI state
    Utils,       // Shared utilities
    Widget,      // Individual UI component
}
```

Key constraints:
- **`MAX_BOUNDARIES_PER_MODULE`**: 20 (prevents rebuild time degradation)
- **`MAX_TOTAL_BOUNDARIES`**: 100 (system-wide cap)

Each boundary has:
- Explicit manifest declaration (not name-based pattern matching)
- Structural ownership rules (which files belong to which boundary)
- Declared dependencies (must be explicit, not inferred)
- Content hash for change detection
- Independent reload capability flag

This enables scenarios like:
- Reload `GuiRender` boundary without touching `CoreLogic`
- Track state per-boundary for partial state preservation
- Cascade reloads only when dependencies actually change

### ABI versioning and rollback

The ABI version manager (`abi_version.rs`) implements **semantic versioning for symbol sets**:

```rust
pub struct AbiVersion {
    pub major: u32,  // Breaking changes
    pub minor: u32,  // Backward-compatible additions
    pub patch: u32,  // Bug fixes
}
```

Compatibility rules:
- Same major + minor >= required = compatible
- Different major = breaking change

The manager maintains:
- **Current versions** per module
- **Previous versions** for rollback (last 2)
- **Expected manifests** for validation before `dlopen`

Symbol manifests include:
- Required vs optional symbols
- Signature information
- Version when added/deprecated

### Module loader with ABI validation

The `ModuleLoader` (`loader.rs`) performs **ABI-validated dynamic loading**:

```rust
pub enum LoadResult {
    Success { module_id: String, abi_version: u32 },
    AbiMismatch { expected: u32, found: u32, details: String },
    MissingSymbols { symbols: Vec<String> },
    LoadError { reason: String },
}
```

Load process:
1. Load library via `libloading::Library::new()`
2. Extract manifest from loaded library
3. Check ABI compatibility against expected manifests
4. Store module info and library handle
5. Maintain load history for debugging

### State manager with explicit versioning

The state manager (`state_manager.rs`) handles **module state lifecycle with migration support**:

```rust
pub struct SchemaVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}
```

Key features:
- **Upgrade paths**: Can upgrade within same major version or to next major
- **Downgrade paths**: Can only downgrade within same major version
- **Field transformations**: Remove, Rename, Transform, Default, MergeInto

Migration schemas specify:
- Fields to preserve
- Fields to reset
- Field renames (old_name → new_name)
- Default values for new fields
- Explicit downgrade path (if reversible)

### Binary state serialization (MessagePack)

The binary state module (`binary_state.rs`) provides **allocation-free serialization** using the size-then-write pattern:

```rust
pub trait StateWriter {
    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), StateWriteError>;
    fn bytes_written(&self) -> usize;
}

pub struct CountingWriter { ... }  // For *_size functions
pub struct SliceWriter<'a> { ... } // For *_write functions
```

MessagePack benefits over JSON:
- **10-50x faster** serialization
- **~40% smaller** payloads
- **Zero-copy** when possible
- Schema-aware migration for structural additions

The `MsgPackSerializer` uses stable field keys (not position-dependent) to avoid ABI churn across versions.

### Crash supervisor policies

The crash supervisor (`supervisor.rs`) manages **crash detection and escalating recovery**:

```rust
pub enum RecoveryAction {
    HotReload,      // First crash: try hot reload
    Rollback,       // Second crash: revert to previous version
    CleanRestart,   // Third crash: restart with clean state
    FullRestart,    // Too many crashes: full process restart
    Fatal,          // Unrecoverable
}
```

Configuration options:
- `max_consecutive_crashes`: Default 3
- `crash_window`: Time window for counting (default 60s)
- `protection_mode`: Fork isolation, signal recovery, or none
- `max_history`: Crash events to keep for debugging

The supervisor tracks:
- Per-module crash counts
- Crash history ring buffer
- Current execution context
- Crash statistics

### Crash recovery with fork isolation

The crash recovery module (`crash_recovery.rs`) provides **safe crash handling for native code**:

**Protection modes:**
- **ForkIsolation**: Crash in child process, parent continues cleanly (safest)
- **SignalRecovery**: Signal-based recovery (faster, less safe)
- **None**: No protection (fastest)

**Critical safety documentation** from the source:
> After SIGSEGV, SIGABRT, or any signal indicating memory corruption:
> - Heap state is UNKNOWN and potentially corrupted
> - Mutex/lock state is UNKNOWN and potentially deadlocked
> - Stack frames may be unwound incorrectly

**What is safe:**
1. Log the crash (if logging doesn't allocate)
2. Store minimal crash info in pre-allocated buffers
3. Exit the process (child only in fork mode)
4. Restart from a clean state

**The only safe recovery is restart with rollback.**

### Source map resolution

The source map module (`source_map.rs`) enables **source-mapped crash reporting**:

```rust
pub struct SourceLocation {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub function: Option<String>,
}

pub struct SourceMappedTrace {
    pub module: String,
    pub frames: Vec<StackFrame>,
    pub has_debug_info: bool,
}
```

Features:
- DWARF debug info parsing (via `addr2line` or `object` crate)
- Address → source:line resolution
- Caching of parsed debug info
- Integration with crash recovery for source-mapped errors

### Parallel compilation

The builder (`builder.rs`) implements **dependency-aware parallel compilation**:

```rust
pub struct ParallelCompileConfig {
    pub max_parallel: usize,  // Default: num_cpus
    pub enabled: bool,
}
```

Process:
1. Build dependency graph from compilation units
2. Topological sort for correct ordering
3. Group units by dependency level
4. Execute each level in parallel (using `tokio::spawn`)
5. Wait for level completion before next level

This minimizes wall-clock time while respecting dependencies.

### Incremental cache with toolchain awareness

The incremental cache (`incremental_cache.rs`) implements **ccache-like object caching**:

Cache key components:
- `source_hash`: Content hash of source file
- `flags_hash`: Hash of compiler flags
- `headers_hash`: Hash of included headers **content** (not just paths)
- `toolchain`: Compiler version, target triple, optimization level, debug info, PIC, LTO mode
- `checksum`: CRC32 integrity validation

Toolchain info ensures cache invalidation when:
- Compiler version changes
- Target triple changes
- Optimization level changes
- C++ standard library version changes

Default limits:
- `MAX_CACHE_SIZE_BYTES`: 100 MB
- `MAX_CACHE_AGE_SECS`: 3600 (1 hour)

### HotApi v2 single-export ABI

The plugin contract (`plugin_contract.rs`) defines the **v2 ABI** with a single export point:

```rust
/// Module exports one symbol: hot_get_api() -> *const HotApi
pub const HOT_API_VERSION: u32 = 2;
pub const HOT_API_MIN_VERSION: u32 = 2;
pub const HOT_API_MAGIC: u64 = 0x484F5441_50495632; // "HOTAPIV2"
```

The `HotApi` table contains function pointers:
- `init`: Initialize state (called once on first load)
- `shutdown`: Cleanup before unload
- `tick`: Per-frame update
- `render`: Render frame
- `event`: Handle input events
- `save_state_msgpack_size` / `save_state_msgpack_write`: Size-then-write serialization
- `load_from_msgpack`: Restore from serialized state
- `migrate`: Version migration (old → new)

Runner provides services via `RunnerApi`:
- `log`: Logging with levels (TRACE, DEBUG, INFO, WARN, ERROR)
- `get_time_ns`: Monotonic time in nanoseconds

### 3-mode hot reload algorithm

The runner implements a **three-mode reload algorithm** (`runner_bin.rs`):

```rust
enum HotReloadResult {
    /// Mode 1: Same version - state pointer reuse (fastest)
    SameVersion,
    /// Mode 2: Version changed - migration via serialized snapshot
    Migrated { preserved_fields: usize, new_fields: usize },
    /// Mode 3: Cold reload - state reset
    ColdReload { reason: String },
    Error(String),
}
```

Decision flow:
1. **Mode 1** triggers when: `state_version` + `abi_fingerprint` + `state_size_bytes` all match
   - Directly copy state memory to new location
2. **Mode 2** triggers when: versions differ but `migrate` function exists and serialized state available
   - Uses MsgPack snapshot for migration (never casts old struct pointers)
3. **Mode 3** triggers when: no migration possible
   - Calls `init` for fresh state

### Pre-reload snapshots

The snapshot manager (`reload_manager.rs`) creates **system snapshots for instant crash revert**:

```rust
pub struct ReloadSnapshot {
    pub snapshot_id: u64,
    pub created_at: Instant,
    pub reload_class: ReloadClass,
    pub module_states: HashMap<ModuleSlot, Vec<u8>>,
    pub boundary_states: HashMap<BoundaryId, Vec<u8>>,
    pub format: SnapshotFormat,
}
```

Snapshot formats:
- **MsgPack**: Binary format (preferred, faster)
- **Json**: Text format (fallback, debuggable)
- **RawMemory**: Only valid for same-version hot swap

Snapshots are created before Warm and Cold reloads (not Safe or Canary).

### Async task registry

The task registry (`reload_manager.rs`) provides **guardrails for background threads**:

- Tracks async tasks spawned by modules
- Provides `prepare_for_reload()` to gracefully stop tasks
- Enforces configurable shutdown timeout
- Essential for Cold reloads that require task shutdown

---
## Appendix: “Why this feels like Next.js”

Synthi borrows three mental models directly from Next.js Fast Refresh, but implements them for native code:

1. **Boundaries:** not every change is hot-swappable; classify and fall back when necessary.
2. **State preservation:** preserve user-visible state whenever safe.
3. **Latency hiding:** debounce + speculative work + incremental caching.

The difference is that in Synthi, these are enforced through:
- an explicit ABI (`HotApi`)
- explicit state serialization and migration
- dynamic library loading
- crash containment mechanisms

That combination is what makes “AI‑HMR for compiled code” feasible.
