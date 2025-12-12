# Synthi AI-HMR System Architecture

## Overview

This document describes the Hot Module Replacement (HMR) system for compiled languages (C++/Rust) that achieves "Next.js-like" developer experience.

## New Modules Added

### 1. Incremental Compilation Cache (`incremental_cache.rs`)

**Purpose**: Avoid full recompilation by caching object files (.o) by content hash.

**Key Features**:
- Content-addressable storage (source hash + flags hash + headers hash → .o file)
- Separate compile (.cpp → .o) and link (.o → .so) steps
- LRU eviction with 100MB cache limit
- Automatic cleanup of stale entries (1 hour max age)

**Usage**:
```rust
use incremental_cache::{IncrementalCache, compile_with_cache, link_objects};

let cache = IncrementalCache::new(cache_dir).await?;
let result = compile_with_cache(&cache, source_path, source_content, &headers, output_dir, "g++", &flags).await?;

if result.was_cached() {
    println!("Cache HIT - {}ms", result.elapsed_ms());
} else {
    println!("Cache MISS - compiled in {}ms", result.elapsed_ms());
}
```

**Impact**: Reduces typical recompile time from 1-5s to 100-300ms for unchanged files.

---

### 2. Field-Level State Diffing (`state_diff.rs`)

**Purpose**: Preserve unchanged state fields during HMR instead of full reset.

**Key Features**:
- JSON-based diffing (works with any serializable state)
- Configurable field preservation rules:
  - `always_preserve`: Fields that should never reset (e.g., `x`, `y`, `position`)
  - `always_reset`: Fields that should always reset (e.g., `animation_frame`)
- Nested object support with max depth control
- Migration reports for debugging

**Usage**:
```rust
use state_diff::{migrate_state, generate_migration_report, DiffConfig};

let (merged_json, diff) = migrate_state(old_json, new_template_json, "core")?;
println!("{}", generate_migration_report(&diff));
// Output: [State Migration]
//   Preserved (5): x, y, position, velocity, user_data
//   Reset (2): frame_count, last_update
```

**Behavior by Module Type**:
- **Core**: Preserves position, velocity, game_state, user_data
- **GUI**: Resets animation_frame, hover_state, transient_ui

---

### 3. Runtime Error Recovery (`crash_recovery.rs`)

**Purpose**: Catch segfaults and other fatal signals without killing the process.

**Key Features**:
- Signal handlers for SIGSEGV, SIGABRT, SIGFPE, SIGBUS (Unix only)
- `execute_with_protection()` wrapper for plugin code
- Automatic rollback to last known-good state
- Crash reports with optional backtraces
- Max 3 consecutive crashes before forced restart

**Usage**:
```rust
use crash_recovery::{install_crash_handlers, execute_with_protection, should_force_restart};

install_crash_handlers()?;

let result = execute_with_protection("gui", || {
    // Plugin code that might crash
    plugin_on_update(state, dt);
});

match result {
    Ok(()) => { /* Success */ }
    Err(crash_info) => {
        println!("Plugin crashed: {}", crash_info.signal_name);
        println!("Old module continues running");
    }
}
```

**HMR Status Events**:
- `crash-recovered`: Plugin crashed but recovered, old module continues
- `crash-fatal`: Too many crashes, restart required

---

### 4. JS ↔ Native HMR Bridge (Updated)

**Files Modified**:
- `compilerClient.js`: Routes native HMR status to JS events
- `useHMR.js`: Handles new status types
- `HMRStatusIndicator.jsx`: Visual feedback for new states

**New HMR Status Types**:
| Status | Description | UI Color |
|--------|-------------|----------|
| `state-migrated` | Field-level migration occurred | Green |
| `crash-recovered` | Runtime crash caught, recovered | Orange |
| `crash-fatal` | Too many crashes, restart needed | Dark Red |
| `host-kv-preserved` | Host KV namespaces preserved | Cyan |
| `host-kv-reset-schema` | Schema changed, namespace reset | Yellow |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                        │
├─────────────────────────────────────────────────────────────────┤
│  HMRStatusIndicator  ◄──── useHMR ◄──── compilerClient          │
│        (UI)              (Hook)        (WebRTC Bridge)          │
└───────────────────────────────┬─────────────────────────────────┘
                                │ WebRTC Data Channel
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Worker (Rust)                             │
├─────────────────────────────────────────────────────────────────┤
│  main.rs                                                         │
│    ├── incremental_cache.rs  (Compile caching)                  │
│    ├── capability.rs         (Export detection)                  │
│    ├── shim.rs              (Auto-shim generation)               │
│    └── builder.rs           (Dependency graph)                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ stdin/stdout
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Runner (Rust)                             │
├─────────────────────────────────────────────────────────────────┤
│  runner_bin.rs                                                   │
│    ├── state_diff.rs        (Field-level state migration)       │
│    ├── crash_recovery.rs    (Signal handlers + recovery)        │
│    ├── host_kv.rs           (Persistent KV storage)             │
│    └── plugin_contract.rs   (ABI v1.0)                          │
└───────────────────────────────┬─────────────────────────────────┘
                                │ dlopen/dlsym
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Plugin Modules (.so/.dll)                     │
├─────────────────────────────────────────────────────────────────┤
│  core.so        │  gui.so         │  main.so (legacy)           │
│  - core_on_load │  - gui_on_load  │  - on_load                  │
│  - core_on_update│ - gui_on_render│  - on_update                │
│  - core_get_api │  - gui_on_event │  - on_save_state            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Comparison with Next.js Fast Refresh

| Feature | Next.js | Synthi | Status |
|---------|---------|--------|--------|
| Instant feedback (<200ms) | ✅ | ⚠️ (100-500ms with cache) | Improved |
| State preservation | ✅ (hooks) | ✅ (field-level diff) | ✓ Implemented |
| Error overlay | ✅ | ❌ (terminal only) | Gap |
| Runtime error recovery | ✅ (error boundaries) | ✅ (signal handlers) | ✓ Implemented |
| Component-level granularity | ✅ | ⚠️ (module-level) | Partial |
| Auto-shimming | N/A | ✅ (blocking → HMR) | Unique |
| AI code splitting | N/A | ✅ | Unique |

---

## Usage Example

```cpp
// User writes blocking code:
int main() {
    SDL_Init(SDL_INIT_VIDEO);
    while (running) {
        handle_events();
        render();
    }
    return 0;
}

// AI splits into Core + GUI automatically
// Runner loads both modules
// User changes button color in GUI
// → Only GUI recompiles (cache hit for core)
// → GUI state migrates (position preserved, animation reset)
// → If GUI crashes, signal handler catches it
// → Old GUI continues running, user sees error
// → User fixes code, saves
// → HMR applies successfully
```

---

## Future Improvements

1. **Error Overlay UI**: Visual compile/runtime error display
2. **Component-level granularity**: AI-assisted widget boundary detection  
3. **Incremental linking**: Use `ld -r` for partial relinking
4. **Source maps**: Debug info preservation across HMR
5. **Cross-session state**: Persist Host KV to disk for IDE restart survival
