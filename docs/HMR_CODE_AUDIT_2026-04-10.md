# HMR Code Audit - 2026-04-10

## Scope

This audit covers the compiled-language HMR implementation across:

- `backend/synthi-webrtc-compiler/worker/src/hmr/`
- `backend/synthi-webrtc-compiler/worker/src/runtime/`
- `backend/synthi-webrtc-compiler/worker/src/compiler/`
- `synthi/src/` files that consume or display HMR state
- `ai-backend/gateway/` and `ai-backend/ai-engine/` HMR-related observability paths

The main question is not whether the repo contains HMR-related code. It does. The real question is which parts are authoritative in the live compiled-language path, which parts are partial integrations, and which parts are effectively design inventory protected by `allow(dead_code)`.

## What Works Today

### Authoritative compiled-language HMR path

For C/C++/Rust/Zig, the real HMR path is:

1. `compiler/handler.rs`
2. `compiler/stages/runner.rs`
3. `runtime/runner_logic.rs`
4. `runtime/hot_reload/v2.rs`
5. `hmr/orchestrator.rs`

That path can already:

- classify rebuild scope
- build a per-session HMR pipeline
- plan reloads
- enqueue and finalize candidates
- reuse the existing runner when GUI mode and resolution are stable
- save state from the old module
- load and validate the new module
- attempt state restore or migration
- emit structured JSON status messages back to the frontend

### Frontend event bridge

The frontend is already wired to consume backend HMR messages through:

- `synthi/src/services/compilerClient.js`
- `synthi/src/hooks/useHMR.js`
- `synthi/src/components/HMRStatusIndicator.jsx`
- `synthi/src/lib/state-restore-status.js`
- `synthi/src/lib/ai-loop-status.js`
- `synthi/src/lib/adapter-status.js`
- `synthi/src/lib/candidate-tracker.js`
- `synthi/src/lib/adapter-health-panel.js`

The bridge now receives:

- `hmr-status`
- `adapter_status`
- `adapter_health`
- `state_restore_status`
- `ai_status`
- candidate lifecycle notifications

### Agentic HMR observability

The backend and gateway already exposed an HMR failure route, but it was not being called from the frontend. That path is now wired through:

- `synthi/src/services/analyzerGatewayClient.js`
- `synthi/src/services/runtimeErrorInterceptor.js`
- `ai-backend/gateway/server.js`
- `ai-backend/ai-engine/main.py`

This means rejected or fatal HMR cycles can now contribute to the agentic observability system instead of remaining a dead integration.

## Changes Landed In This Pass

### 1. Slot-aware build manifest targeting

`compiler/handler.rs` previously built the HMR manifest from the core artifact even when the change was GUI-only. That made the planner and adapter metadata point at the wrong binary.

The handler now:

- selects the correct manifest slot for core, GUI, or full-session reloads
- points the manifest at the correct artifact path
- uses slot-aware artifact and schema hashes
- discovers exported symbols from the actual changed artifact set
- computes schema-change detection from slot-aware schema hashes instead of always using core

### 2. Dynlib authority fix

`compiler/handler.rs` could treat a successful dynamic-library adapter preflight as an authoritative `ProcessSwap` success. That is incorrect because dynlib reloads are still runner-authoritative.

The handler now ensures:

- dynamic-library adapter success is never treated as authoritative process-swap completion
- dynlib paths always fall through to the runner for the actual compiled-language swap

### 3. Dynlib symbol validation activated

`hmr/dynlib_adapter.rs` previously validated only file extensions. It now consumes the exported-symbol manifest when present and runs real core/gui symbol checks before reporting dynlib preflight success.

That activates part of the previously dormant symbol-validation layer without making the dynlib adapter authoritative.

### 4. HMR failure observability activated

`runtimeErrorInterceptor.js` now reports real HMR failures through the gateway with cooldown-based deduplication.

## Active vs Partial vs Dormant Modules

### A. Live compiled-language path

These files are directly in the live HMR path for compiled native modules:

- `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`
- `backend/synthi-webrtc-compiler/worker/src/compiler/stages/runner.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/runner_logic.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/hot_reload/v2.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/capability.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/loader.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/runner_state.rs`
- `backend/synthi-webrtc-compiler/worker/src/runtime/plugin_contract.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/orchestrator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/integration.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/planner.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/planner_glue.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/build_manifest.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_registry.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_trait.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_adapter.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/candidate.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/candidate_queue.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/candidate_bridge.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/candidate_notification.rs`

### B. Live frontend bridge and status consumers

- `synthi/src/services/compilerClient.js`
- `synthi/src/hooks/useHMR.js`
- `synthi/src/components/HMRStatusIndicator.jsx`
- `synthi/src/services/runtimeErrorInterceptor.js`
- `synthi/src/hooks/useRuntimeHealing.js`
- `synthi/src/lib/hmr-runtime.js`
- `synthi/src/lib/state-restore-status.js`
- `synthi/src/lib/ai-loop-status.js`
- `synthi/src/lib/adapter-status.js`
- `synthi/src/lib/candidate-tracker.js`
- `synthi/src/lib/adapter-health-panel.js`
- `synthi/src/lib/preview-store-bridge.js`

### C. Live AI-backend and gateway HMR integration

- `ai-backend/gateway/server.js`
- `ai-backend/ai-engine/main.py`

These are live now, but only as observability plumbing. They are not part of the core reload algorithm.

### D. Partially integrated native HMR support files

These files are real implementations, but they are not all authoritative in the current path:

- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_matrix.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapter_lifecycle_fsm.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/health_check.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/promotion_policy.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/reload_protocol.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/reload_manager.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_manager.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_checkpoint.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_snapshot.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_diff.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_serializer.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_restore_orchestrator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_restore_validator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/state_migration.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/symbol_validation.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/fast_refresh.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/preview_lifecycle.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/lifecycle_machine.rs`

These are not fake. They are just not all equally authoritative in the hot path.

### E. Managed runtime stack: present, not production-ready

- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_runtime_adapter.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_runtime_hooks.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_health_probe.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_dotnet_reload.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_classloader_strategy.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/managed_agent_protocol.rs`

Status:

- adapter objects exist
- basic placeholder reload behavior exists
- main Java compile path still routes to a dedicated handler before the generic HMR pipeline
- C# does not have a fully wired end-to-end compile path here

Conclusion: this stack is scaffolded, not complete.

### F. Process-swap stack: materially implemented, not fully surfaced

- `backend/synthi-webrtc-compiler/worker/src/hmr/process_swap_adapter.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/process_swap_drain.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/process_swap_handoff.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/process_swap_socket_handoff.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/process_swap_state_transfer.rs`

Status:

- the adapter is not a stub
- process spawn, ready signaling, handoff transport selection, and old-process retirement all exist
- but the language-routing and planner semantics around this family are still incomplete at the product level

Conclusion: this stack is real, but not yet consistently reachable through the repo's current compile flows.

### G. AI gate / loop-control stack: present but selectively used

- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_bypass.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_gate.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_cache.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_circuit_breaker.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_cost_tracker.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_timeout_guardian.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_request_contract.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_response_validator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_fallback_chain.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/loop_classifier.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/loop_b_triggers.rs`

Status:

- `ai_bypass.rs` and loop classification are live
- much of the deeper AI governance stack is only partially consumed

Conclusion: the AI layer is split between live gates and dormant support infrastructure.

### H. Change-classification and dependency-analysis bucket

- `backend/synthi-webrtc-compiler/worker/src/hmr/changed_files.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/compile_enrichment.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dependency_graph.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dirty_classifier.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/rebuild_scope.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/scope_planner_bridge.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/shared_header_detect.rs`

Status:

- enrichment and rebuild-scope usage are live enough to matter
- deeper dependency and dirty-file reasoning is still not the dominant planner input

### I. Rollback, diagnostics, and ABI-support bucket

- `backend/synthi-webrtc-compiler/worker/src/hmr/diagnostics.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/hmr_eligibility.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/hot_swap_coordinator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_abi_contract.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_build_hooks.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_crash_isolation.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_language_profiles.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_metrics.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_preload_validator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_reload.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_rollback.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_state_bridge.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_swap.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/dynlib_symbol_resolver.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/swap_rollback.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/rollback_notification.rs`

Status:

- pieces of this bucket are useful support code
- much of it is still not the path that actually decides reload success in production

### J. Miscellaneous HMR support bucket

- `backend/synthi-webrtc-compiler/worker/src/hmr/abi_detect.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/adapted_project.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/cache_writer.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/deterministic_compile.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/incremental_cache.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/orchestrator.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/planner_decision.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/rollout_flags.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/telemetry.rs`

### K. Test-only HMR files

- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_extraction_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/planner_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave05_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave06_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave07_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave08_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave09_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave10_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave11_integration_tests.rs`
- `backend/synthi-webrtc-compiler/worker/src/hmr/wave12_integration_tests.rs`

These are not dead code. They are test-only code.

## Dead-Code and Unused-Code Buckets

### Bucket 1: File-level dead-code suppression on live modules

Many runtime modules still start with file-level `#![allow(dead_code)]` even when parts of the file are live. That usually means one of two things:

- the file contains both active and dormant APIs
- a previous dead-code cleanup never narrowed the suppression after integration work landed

This is true for files such as:

- `runtime/capability.rs`
- `runtime/loader.rs`
- `runtime/supervisor.rs`
- `hmr/dynlib_adapter.rs`
- `hmr/process_swap_adapter.rs`
- `hmr/managed_runtime_adapter.rs`
- several state and reload support modules

### Bucket 2: Planner and adapter semantics do not line up perfectly

The planner decides reload shape, but the repo still relies on special-case authority rules in the handler for dynlib paths. That means planner output and adapter execution are not yet a single authoritative abstraction.

### Bucket 3: Managed runtime support is scaffolded, not finished

The managed-runtime files are present, but the repo does not yet treat Java/.NET as first-class HMR citizens end-to-end.

### Bucket 4: Process-swap support is implemented but not consistently surfaced

The process-swap adapter is real code, but product-level routing to it is still incomplete.

### Bucket 5: Overbuilt support layers

Some support modules are valid design inventory but not core to the live HMR cycle today. These should either be wired fully or narrowed behind feature flags and targeted `allow` attributes.

## Will The Current HMR Structure Work?

### For compiled dynlib languages

For C/C++/Rust/Zig, yes, with caveats.

The structure is coherent enough to work when:

- the runner is already alive
- GUI mode and resolution are stable
- the module exports the expected hooks
- state shape is compatible or migratable
- the reload path reaches the runner for authoritative swap

The repo is not relying on browser-style HMR magic. It is doing a real compiled reload through the runner.

### Where it is still fragile

- dynlib authority is split between planner/adapter preflight and runner-authoritative reload
- some planner decisions still represent desired architecture more than fully unified runtime behavior
- full-session manifests still compress multiple artifacts into one planner-facing object, which is acceptable for now but not ideal
- many support files are still broader than the live surface area

### For managed runtimes

Not fully. The scaffolding exists, but the product path is not fully integrated.

### For process-swap languages

The adapter exists and the mechanism is materially implemented, but the repo is not yet fully consistent about routing real compile flows through it.

## Priority Follow-Up Plan

### Phase 1: tighten the live native path

1. Make planner decision and adapter selection share one authoritative rule set.
2. Split full-session manifests into explicit per-slot candidate metadata where necessary.
3. Replace broad `allow(dead_code)` at file scope with narrower item-level allowances on live files.

### Phase 2: finish productizing process swap

1. Confirm the compile pipeline actually routes supported languages into `ProcessSwapAdapter`.
2. Add end-to-end tests that prove authoritative candidate promotion and rollback in process-swap mode.

### Phase 3: either finish or quarantine managed runtime HMR

1. If Java/.NET HMR is real product scope, route those languages through the common HMR pipeline and complete host reload semantics.
2. If not, quarantine the managed-runtime stack behind an explicit feature flag so it stops polluting dead-code noise.

### Phase 4: reduce dead-code fog

1. Audit every file-level `#![allow(dead_code)]` in `worker/src/hmr/`, `worker/src/runtime/`, and related support modules.
2. For each file, choose one action only:
   - wire it
   - narrow the suppression
   - move it behind a feature flag
   - delete it

## Bottom Line

The compiled-language HMR system is real and not just architecture-doc theater. The dynlib path is the most mature and can work correctly. The main problems are not that HMR is absent; they are that the abstraction layers are not fully unified and too many support modules still look live because broad dead-code suppressions hide which parts are truly authoritative.