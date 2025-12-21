# Parallel Abstractions Consolidation Plan

**Generated:** December 20, 2025  
**Status:** ✅ IMPLEMENTED

---

## Summary

The consolidation has been implemented. The `HmrOrchestrator` is now the single entry point for:
- State save/load operations (binary-first with JSON fallback)
- Schema compatibility checking
- Field-level state migration

### Changes Made

1. **hmr_orchestrator.rs** - Added new methods:
   - `save_module_state()` - Unified state save (binary/JSON)
   - `load_module_state()` - Unified state load with migration
   - `get_template_json()` - Template generation for diffing
   - `check_schema_compatibility()` - Schema hash validation
   - New types: `SavedState`, `LoadedState`, `MigrationSummary`, `SchemaCompatibility`

2. **runner_bin.rs** - Wired up orchestrator:
   - Added `HmrOrchestrator` instance
   - Phase 2 (state save) now uses `orchestrator.save_module_state()`
   - Phase 3 (state restore) now uses `orchestrator.load_module_state()`
   - Removed ~100 lines of inline dlsym and migration code

3. **main.rs** - Re-exports new types for external use

---

## The Problem (SOLVED)

The AI-HMR system has **three parallel abstraction layers** that do the same things differently:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CURRENT: PARALLEL ABSTRACTIONS                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  STATE MANAGEMENT:                                                          │
│  ┌──────────────────┐    ┌─────────────────┐    ┌──────────────────────┐   │
│  │ Inline in        │    │ StateManager    │    │ HmrOrchestrator      │   │
│  │ runner_bin.rs    │◄───│ (imported,      │    │ (has migrate_state,  │   │
│  │ (ACTUALLY USED)  │    │  ~15% used)     │    │  NOT called)         │   │
│  └──────────────────┘    └─────────────────┘    └──────────────────────┘   │
│                                                                             │
│  SERIALIZATION:                                                             │
│  ┌──────────────────┐    ┌─────────────────┐                               │
│  │ JSON (state_diff)│    │ MessagePack     │                               │
│  │ (ALWAYS USED     │    │ (binary_state)  │                               │
│  │  as fallback)    │    │ (partial use)   │                               │
│  └──────────────────┘    └─────────────────┘                               │
│                                                                             │
│  RELOAD CLASSIFICATION:                                                     │
│  ┌──────────────────┐    ┌─────────────────┐    ┌──────────────────────┐   │
│  │ Inline if/else   │    │ ReloadManager   │    │ HmrOrchestrator      │   │
│  │ in runner_bin.rs │◄───│ ReloadClass     │    │ reload_classifier    │   │
│  │ (ACTUALLY USED)  │    │ (~10% used)     │    │ (NOT called)         │   │
│  └──────────────────┘    └─────────────────┘    └──────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Evidence from Code

**runner_bin.rs (the actual runtime):**
```rust
// Line 367: StateManager created but barely used
let mut state_manager = StateManager::new();

// Lines 800-1000: Inline state save/restore logic
// - Binary save: old_lib.get(b"core_on_save_state_binary")
// - JSON fallback: old_lib.get(b"core_on_save_state")
// - JSON migration: migrate_state(old_json, template_json, module_type)
// ^^^ All inline, doesn't use StateManager.migrate_*()
```

**HmrOrchestrator exists but is never instantiated in runner_bin.rs:**
```rust
// hmr_orchestrator.rs has:
// - hot_reload() method
// - migrate_binary_state() method
// - reload_classifier integration
// - snapshot creation
// BUT runner_bin.rs does all this manually
```

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     TARGET: UNIFIED ORCHESTRATOR                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  runner_bin.rs                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  // ONE entry point for all HMR operations                             │ │
│  │  let orchestrator = HmrOrchestrator::new();                            │ │
│  │                                                                        │ │
│  │  // On reload signal:                                                  │ │
│  │  let result = orchestrator.hot_reload(                                 │ │
│  │      ModuleSlot::Core,                                                 │ │
│  │      &new_path,                                                        │ │
│  │      &changes,         // Auto-classifies: Safe/Warm/Cold              │ │
│  │      old_state_bytes,  // Binary (fast) or JSON (fallback)             │ │
│  │      &field_names,                                                     │ │
│  │  );                                                                    │ │
│  │                                                                        │ │
│  │  // Result contains: preserved_fields, new_state_ptr, binary_used      │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  HmrOrchestrator (internal delegation)                                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   ┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐   │ │
│  │   │ ReloadClass │────▶│ StateManager     │────▶│ Serialization    │   │ │
│  │   │ Classifier  │     │ (owns lifecycle) │     │ Strategy         │   │ │
│  │   └─────────────┘     └──────────────────┘     └──────────────────┘   │ │
│  │          │                     │                       │              │ │
│  │          ▼                     ▼                       ▼              │ │
│  │   Safe/Warm/Cold        migrate_binary()        Binary → JSON        │ │
│  │                         migrate_json()          fallback chain       │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Consolidation Plan

### Phase 1: Wire Up Orchestrator (4-6 hours)

**Goal:** Replace inline HMR logic in runner_bin.rs with HmrOrchestrator calls.

#### Step 1.1: Add orchestrator instance to runner_bin.rs

```rust
// At top of main(), after crash_handlers:
let mut orchestrator = HmrOrchestrator::new();
eprintln!("[Runner] HmrOrchestrator initialized");
```

#### Step 1.2: Replace inline state save/restore

**Current (lines 800-920 in runner_bin.rs):**
```rust
// INLINE: Try binary, then JSON
let save_binary = old_lib.get(b"core_on_save_state_binary");
if let Ok(f) = save_binary { ... }
if binary_state.is_none() {
    let save_func = old_lib.get(b"core_on_save_state");
    ...
}
```

**Proposed:**
```rust
// DELEGATED: Orchestrator handles serialization strategy
let (saved_bytes, was_binary) = orchestrator.save_module_state(
    ModuleSlot::Core,
    &old_lib,
    state_to_save,
);
```

#### Step 1.3: Replace inline reload logic

**Current (scattered across 200+ lines):**
```rust
// Schema hash check
if old_schema_hash != new_schema_hash { ... }
// Try binary load
if let Some(ref binary_data) = binary_state { ... }
// Fall back to JSON
if !state_restored { ... }
// Field-level diff
match migrate_state(...) { ... }
```

**Proposed:**
```rust
let hmr_result = orchestrator.hot_reload(
    ModuleSlot::Core,
    &new_lib_path,
    &ReloadChanges::from_hashes(old_hash, new_hash),
    saved_bytes.as_deref(),
    json_state.as_ref().map(|c| c.to_str().unwrap_or("{}")),
    &detected_field_names,
);

if hmr_result.success {
    new_state = hmr_result.new_state_ptr;
    eprintln!("[HMR] Preserved: {:?}", hmr_result.preserved_fields);
} else {
    eprintln!("[HMR] Failed: {:?}", hmr_result.error);
    // orchestrator.rollback_to_snapshot() if snapshot_enabled
}
```

### Phase 2: Unify Serialization (2-3 hours)

**Goal:** Single SerializationStrategy enum that handles binary-vs-JSON internally.

```rust
// In binary_state.rs or new unified module:
pub enum SerializationStrategy {
    /// Binary (MessagePack) - 25x faster, schema-aware
    Binary {
        save_fn: Symbol<OnSaveStateBinaryFn>,
        load_fn: Symbol<OnLoadFromBinaryFn>,
    },
    /// JSON - Universal fallback, slower but debuggable
    Json {
        save_fn: Symbol<OnSaveStateFn>,
        load_fn: Symbol<OnLoadFromJsonFn>,
    },
    /// Hybrid - Save binary, load JSON (for debugging)
    Hybrid {
        save_binary: Symbol<OnSaveStateBinaryFn>,
        load_json: Symbol<OnLoadFromJsonFn>,
    },
}

impl SerializationStrategy {
    /// Auto-detect best strategy from library exports
    pub fn detect(lib: &Library, slot: ModuleSlot) -> Self { ... }
    
    /// Save state using detected strategy
    pub fn save(&self, state: *mut c_void) -> SavedState { ... }
    
    /// Load state using detected strategy with migration
    pub fn load(&self, saved: &SavedState, migrator: &SchemaMigrator) -> *mut c_void { ... }
}
```

### Phase 3: Remove Dead Code (1-2 hours)

After wiring up orchestrator, these become truly dead:

| File | Remove | Keep |
|------|--------|------|
| `state_manager.rs` | Inline `migrate_json()` | `StateManager`, `MigrationSchema` |
| `reload_manager.rs` | `CanaryValidator` | `ReloadClass`, `ReloadClassifier` |
| `supervisor.rs` | Most of it | `RecoveryAction` enum |
| `loader.rs` | All | Nothing (use libloading directly) |

**Lines removed:** ~3,000-4,000

---

## File-by-File Changes

### runner_bin.rs

```diff
+ use crate::hmr_orchestrator::{HmrOrchestrator, HmrResult};

  fn main() {
+     let mut orchestrator = HmrOrchestrator::new();
      
      // In reload handler:
-     // 200 lines of inline HMR logic
+     let result = orchestrator.hot_reload(...);
+     handle_hmr_result(result);
  }
```

### hmr_orchestrator.rs

```diff
  impl HmrOrchestrator {
+     /// Save module state (auto-detects binary vs JSON)
+     pub fn save_module_state(
+         &self,
+         slot: ModuleSlot,
+         lib: &Library,
+         state: *mut c_void,
+     ) -> (Option<Vec<u8>>, bool) {
+         let strategy = SerializationStrategy::detect(lib, slot);
+         strategy.save(state)
+     }
+     
+     /// Complete HMR cycle with all checks
      pub fn hot_reload(
          &mut self,
          slot: ModuleSlot,
+         new_lib: &Library,  // NEW: pass library reference
          new_path: &Path,
          changes: &ReloadChanges,
          old_state_bytes: Option<&[u8]>,
          old_json: Option<&str>,
          new_field_names: &[String],
      ) -> HmrResult {
          // Existing logic already handles most of this
+         // Add: schema hash validation
+         // Add: actual dlsym calls for load functions
      }
  }
```

### state_diff.rs

```diff
  // Keep: diff_and_merge(), DiffConfig, DiffResult
  // Keep: diff_and_merge_binary()
  
- // Remove: migrate_state() wrapper (use StateManager instead)
- pub fn migrate_state(...) { ... }
```

---

## Migration Sequence

1. **Add orchestrator to runner_bin.rs** (no behavior change)
2. **Add `save_module_state()` to orchestrator** (delegates to existing code)
3. **Replace inline save logic** with orchestrator call
4. **Add `load_module_state()` to orchestrator**
5. **Replace inline load/migrate logic** with orchestrator call
6. **Run tests** to verify identical behavior
7. **Remove duplicate code** from runner_bin.rs
8. **Mark truly dead code** in other modules

---

## Validation Checklist

- [ ] HMR still works for Core module
- [ ] HMR still works for GUI module
- [ ] Binary state path is preferred when available
- [ ] JSON fallback works when binary unavailable
- [ ] Schema hash mismatch triggers cold reload
- [ ] Field-level diffing preserves x, y, running, etc.
- [ ] Crash recovery still functions
- [ ] WebRTC status messages unchanged

---

## Appendix: Current Call Graph

```
runner_bin.rs main loop
    │
    ├── inline: old_lib.get(b"core_on_save_state_binary")
    ├── inline: old_lib.get(b"core_on_save_state")  
    ├── inline: schema hash check
    ├── inline: new_lib.get(b"core_on_load_from_binary")
    ├── inline: new_lib.get(b"core_on_load_from_json")
    └── state_diff::migrate_state()  ← ONLY external call
            │
            └── diff_and_merge()
    
    NOT CALLED:
    ├── HmrOrchestrator::hot_reload()
    ├── StateManager::migrate_binary()
    ├── StateManager::migrate_json()
    ├── ReloadClassifier::classify()
    └── CrashSupervisor::determine_action()
```

**After consolidation:**
```
runner_bin.rs main loop
    │
    └── orchestrator.hot_reload()
            │
            ├── reload_classifier.classify()
            ├── state_manager.save()     → SerializationStrategy
            ├── state_manager.migrate()  → diff_and_merge / diff_and_merge_binary
            ├── state_manager.load()     → SerializationStrategy  
            └── crash_supervisor.wrap()  → RecoveryAction
```
