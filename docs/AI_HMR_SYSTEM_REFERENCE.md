# Synthi AI-HMR System: Complete Technical Reference

> **Version**: 2.0 (December 2025)  
> **Status**: Production-Ready Architecture  
> **Target Audience**: System Architects, Backend Engineers, Security Engineers

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Process Isolation Model](#3-process-isolation-model)
4. [ABI Fingerprinting & Memory Safety](#4-abi-fingerprinting--memory-safety)
5. [State Management & Migration](#5-state-management--migration)
6. [IPC Protocol Specification](#6-ipc-protocol-specification)
7. [Hot Reload Classification](#7-hot-reload-classification)
8. [Crash Recovery & Supervision](#8-crash-recovery--supervision)
9. [DWARF-Based Layout Extraction](#9-dwarf-based-layout-extraction)
10. [Security Model](#10-security-model)
11. [Performance Characteristics](#11-performance-characteristics)
12. [Integration Guide](#12-integration-guide)

---

## 1. Executive Summary

The Synthi AI-HMR (Hot Module Replacement) system enables **sub-second iteration cycles** for native code development by allowing compiled shared libraries (`.so`/`.dll`) to be swapped at runtime without restarting the application. This is fundamentally different from interpreted language HMR (JavaScript, Python) because native code presents unique challenges:

- **Memory Layout**: Struct layouts are baked into compiled code
- **ABI Compatibility**: Calling conventions, symbol mangling, alignment
- **Resource Cleanup**: No garbage collector to handle dangling references
- **Process Safety**: `dlclose()` is undefined behavior in many scenarios

The system solves these challenges through:

1. **Process Isolation**: Modules run in disposable child processes
2. **Strict ABI Fingerprinting**: DWARF-based layout verification before memcpy
3. **Serialization-First Migration**: MsgPack snapshots over raw pointer casting
4. **Hard Timeouts**: No operation waits forever; kill and restart on timeout

### Key Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| Hot reload latency (same layout) | <100ms | ~50ms |
| Hot reload latency (migration) | <500ms | ~200ms |
| Cold reload latency | <2s | ~1s |
| Crash recovery time | <3s | ~2s |
| Memory overhead | <50MB | ~30MB |

---

## 2. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GATEWAY PROCESS                                 │
│  (Node.js/Rust - handles WebSocket, authentication, session management)     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ stdin/stdout (JSON commands, status)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUPERVISOR PROCESS                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ProcessSupervisor                                                   │    │
│  │  - Event loop (run_event_loop)                                       │    │
│  │  - Command parsing (load, reload, snapshot, shutdown)                │    │
│  │  - Health monitoring (ping/pong, heartbeat timeout)                  │    │
│  │  - Crash recovery (restart with state restoration)                   │    │
│  │  - State snapshot storage (HashMap<slot, Vec<u8>>)                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ Binary IPC (length-prefixed MsgPack)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            WORKER PROCESS                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                       │
│  │  Core Module │  │  GUI Module  │  │  Audio Module│  (dynamic .so/.dll)   │
│  │  - State     │  │  - State     │  │  - State     │                       │
│  │  - on_update │  │  - on_render │  │  - on_sample │                       │
│  │  - on_event  │  │  - on_event  │  │              │                       │
│  └──────────────┘  └──────────────┘  └──────────────┘                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  HMR Orchestrator                                                    │    │
│  │  - Module loading (libloading)                                       │    │
│  │  - State serialization (MsgPack)                                     │    │
│  │  - ABI validation (enhanced_fingerprint)                             │    │
│  │  - Reload classification (Safe/Warm/Cold)                            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Graphics Subsystem (SDL2 + X11/Wayland)                            │    │
│  │  - Window management                                                 │    │
│  │  - Frame capture (shared memory)                                     │    │
│  │  - Input forwarding                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Failure Mode |
|-----------|---------------|--------------|
| Gateway | WebSocket, auth, routing | Restart process |
| Supervisor | Worker lifecycle, crash recovery | Restart worker |
| Worker | Module execution, rendering | Killed & restarted by supervisor |
| Module | Application logic | Hot-reloaded or cold-restarted |

---

## 3. Process Isolation Model

### Why Process Isolation is Mandatory

The fundamental problem with in-process `dlopen`/`dlclose`:

```c
// This is UNDEFINED BEHAVIOR in most real-world scenarios:
void* handle = dlopen("libmodule.so", RTLD_NOW);
// ... use library ...
dlclose(handle);  // UB if:
                  // - Any thread is running code from the library
                  // - TLS destructors exist
                  // - atexit() handlers registered
                  // - Signal handlers point into library
                  // - Callbacks stored anywhere
                  // - Static/global destructors exist
```

**The only safe way to unload native code is to terminate the process.**

### Execution Modes

```rust
pub enum ExecutionMode {
    /// DEFAULT: Modules run in isolated child process
    /// Safe: dlclose UB is contained in disposable process
    ProcessIsolated,
    
    /// DEPRECATED: Direct library loading in supervisor process
    /// Requires SYNTHI_UNSAFE_INPROCESS=1 environment variable
    #[deprecated]
    UnsafeInProcess,
}
```

### Process Lifecycle

```
1. Supervisor spawns Worker process
2. Worker loads modules via dlopen()
3. Worker runs application loop
4. On HMR request:
   a. Worker serializes state to MsgPack
   b. Worker sends snapshot via IPC
   c. Supervisor kills Worker (SIGKILL)
   d. Supervisor spawns new Worker
   e. New Worker loads new module version
   f. New Worker deserializes state from snapshot
5. Application continues with new code
```

### IPC Channel Setup

```rust
// Supervisor side
let mut cmd = Command::new(&self.config.worker_binary);
cmd.stdin(Stdio::piped())
   .stdout(Stdio::piped())
   .stderr(Stdio::inherit());  // Logs go to supervisor's stderr

let mut child = cmd.spawn()?;
let stdin = child.stdin.take()?;   // Supervisor writes commands
let stdout = child.stdout.take()?; // Supervisor reads responses
```

---

## 4. ABI Fingerprinting & Memory Safety

### The Memcpy Problem

When hot-reloading, we want to preserve application state. The naive approach:

```rust
// DANGEROUS: Assumes old and new structs have identical memory layout
unsafe {
    std::ptr::copy_nonoverlapping(
        old_state as *const u8,
        new_state as *mut u8,
        state_size,
    );
}
```

This fails silently when:
- Field order changed
- Field types changed (same size, different meaning)
- Padding changed (different compiler flags)
- Alignment requirements changed

### ABI Fingerprint Structure

```rust
pub struct AbiFingerprint {
    /// Compiler identification (gcc, clang, rustc + version)
    pub compiler: CompilerInfo,
    
    /// Target triple (x86_64-unknown-linux-gnu, etc.)
    pub target_triple: String,
    
    /// Optimization level (-O0, -O2, -O3)
    pub opt_level: OptLevel,
    
    /// LTO mode (none, thin, fat)
    pub lto_mode: LtoMode,
    
    /// Position-independent code enabled
    pub pic_enabled: bool,
    
    /// CRITICAL: Hash of struct field offsets, sizes, types
    /// If None, memcpy is FORBIDDEN
    pub layout_hash: Option<u64>,
    
    /// Module's declared state version
    pub state_version: u32,
    
    /// Module's declared ABI fingerprint
    pub module_fingerprint: u64,
    
    /// Build ID from ELF .note.gnu.build-id
    pub build_id: Option<String>,
}
```

### Compatibility Check Algorithm

```rust
pub fn is_compatible_for_memcpy(&self, other: &AbiFingerprint) -> CompatibilityResult {
    let mut issues = Vec::new();
    
    // 1. Compiler must match exactly
    if self.compiler != other.compiler {
        issues.push("Compiler mismatch");
    }
    
    // 2. Target must match
    if self.target_triple != other.target_triple {
        issues.push("Target mismatch");
    }
    
    // 3. Layout hash is MANDATORY for memcpy
    match (self.layout_hash, other.layout_hash) {
        (Some(a), Some(b)) if a != b => {
            issues.push("Layout hash mismatch");
        }
        (None, _) | (_, None) => {
            issues.push("Layout hash missing - memcpy forbidden");
        }
        _ => {} // OK
    }
    
    // 4. State version must match
    if self.state_version != other.state_version {
        issues.push("State version mismatch");
    }
    
    if issues.is_empty() {
        CompatibilityResult::Compatible
    } else {
        CompatibilityResult::Incompatible { reasons: issues }
    }
}
```

### Decision Tree

```
                    ┌─────────────────────┐
                    │ Hot Reload Request  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Extract Fingerprint │
                    │ from new .so        │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼─────────┐      │      ┌─────────▼─────────┐
    │ layout_hash       │      │      │ layout_hash       │
    │ present?          │      │      │ matches?          │
    └─────────┬─────────┘      │      └─────────┬─────────┘
              │                │                │
         NO   │           YES  │           NO   │  YES
              │                │                │
    ┌─────────▼─────────┐      │      ┌─────────▼─────────┐
    │ BLOCK MEMCPY      │      │      │ Use Serialized    │
    │ Use migration     │      │      │ Migration         │
    └───────────────────┘      │      └───────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Safe Memcpy         │
                    │ (Same layout)       │
                    └─────────────────────┘
```

---

## 5. State Management & Migration

### State Serialization Protocol

The system uses a **binary-first** approach with MsgPack:

```rust
// Module exports these functions via HotApi
pub struct HotApi {
    // Serialize state to MsgPack
    pub save_state: Option<fn(state: *const c_void, out: &mut Vec<u8>) -> bool>,
    
    // Deserialize state from MsgPack
    pub load_state: Option<fn(state: *mut c_void, data: &[u8]) -> bool>,
    
    // Migrate from old version to new version
    pub migrate: Option<fn(
        old_state: *const c_void,
        old_version: u32,
        new_state: *mut c_void,
        new_version: u32,
        msgpack: *const u8,
        msgpack_len: usize,
    ) -> bool>,
    
    // State metadata
    pub state_version: u32,
    pub state_size_bytes: usize,
    pub state_align_bytes: usize,
    pub abi_fingerprint: u64,
}
```

### Migration Strategies

| Strategy | When Used | Latency | Data Loss |
|----------|-----------|---------|-----------|
| **Memcpy** | layout_hash matches exactly | ~1ms | None |
| **Deserialize** | layout_hash differs, schema compatible | ~10ms | None |
| **Migrate** | state_version differs | ~50ms | Possible |
| **Cold Reload** | No compatible migration | ~500ms | Full state lost |

### Example Migration Function

```c
// In plugin code
bool hot_migrate(
    const void* old_state, uint32_t old_version,
    void* new_state, uint32_t new_version,
    const uint8_t* msgpack_data, size_t msgpack_len
) {
    // Prefer MsgPack if available (schema-aware)
    if (msgpack_data && msgpack_len > 0) {
        return deserialize_from_msgpack(new_state, msgpack_data, msgpack_len);
    }
    
    // Fallback: field-by-field migration
    if (old_version == 1 && new_version == 2) {
        const StateV1* v1 = (const StateV1*)old_state;
        StateV2* v2 = (StateV2*)new_state;
        
        v2->x = v1->x;
        v2->y = v1->y;
        v2->new_field = DEFAULT_VALUE;  // New field
        return true;
    }
    
    return false;  // Unknown migration path
}
```

---

## 6. IPC Protocol Specification

### Wire Format

All IPC uses **length-prefixed binary frames**:

```
┌─────────────────────────────────────────┐
│  4 bytes: payload length (big-endian)   │
├─────────────────────────────────────────┤
│  N bytes: MsgPack-encoded payload       │
└─────────────────────────────────────────┘
```

**Maximum frame size**: 64 MB (configurable)

### Message Types

#### Supervisor → Worker

```rust
enum IpcMessage {
    // Load a module into a slot
    LoadModule {
        slot: String,           // "core", "gui", "audio"
        path: String,           // "/path/to/module.so"
        state_snapshot: Option<Vec<u8>>,  // Previous state
    },
    
    // Hot reload a module
    ReloadModule {
        slot: String,
        path: String,
        state_snapshot: Option<Vec<u8>>,
    },
    
    // Request state snapshot
    RequestSnapshot { slot: String },
    
    // Forward input event
    InputEvent { kind: u32, a: u32, b: u32, c: u32 },
    
    // Shutdown with timeout
    Shutdown { timeout_ms: u32 },
    
    // Health check
    Ping { seq: u64 },
}
```

#### Worker → Supervisor

```rust
enum IpcMessage {
    // Module loaded successfully
    ModuleLoaded {
        slot: String,
        abi_version: u32,
        state_version: u32,
        fingerprint: u64,
        layout_hash: Option<u64>,
    },
    
    // Reload completed
    ReloadResult {
        slot: String,
        success: bool,
        preserved_fields: Vec<String>,
        error: Option<String>,
    },
    
    // State snapshot
    Snapshot {
        slot: String,
        data: Vec<u8>,
        state_version: u32,
    },
    
    // Frame rendered
    FrameReady { width: u32, height: u32, format: String },
    
    // Health check response
    Pong { seq: u64 },
    
    // Error report
    Error { module: Option<String>, message: String, fatal: bool },
    
    // Worker ready
    Ready,
    
    // Worker shutting down
    ShuttingDown,
}
```

### Frame Read/Write Implementation

```rust
const FRAME_HEADER_SIZE: usize = 4;
const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_SIZE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Frame too large"));
    }
    
    let len = payload.len() as u32;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(payload)?;
    Ok(())
}

fn read_frame(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut header = [0u8; FRAME_HEADER_SIZE];
    reader.read_exact(&mut header)?;
    
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Frame too large"));
    }
    
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(payload)
}
```

---

## 7. Hot Reload Classification

### Reload Types

```rust
pub enum HotReloadResult {
    /// Layout identical - direct memcpy (fastest)
    SameVersion,
    
    /// Layout changed but migrated successfully
    Migrated {
        preserved_fields: u32,
        new_fields: u32,
    },
    
    /// Full restart required
    ColdReload { reason: String },
}
```

### Classification Algorithm

```rust
fn classify_reload(old: &HotModuleState, new_api: &HotApi) -> ReloadType {
    // 1. Check if we have fingerprints
    let (old_fp, new_fp) = match (&old.full_fingerprint, extract_fingerprint(new_path)) {
        (Some(o), Ok(n)) => (o, n),
        _ => return ReloadType::Cold("Missing fingerprint"),
    };
    
    // 2. Check layout hash
    match (old_fp.layout_hash, new_fp.layout_hash) {
        (Some(a), Some(b)) if a == b => {
            // Same layout - can memcpy
            if old_fp.is_compatible_for_memcpy(&new_fp).is_compatible() {
                return ReloadType::Safe;
            }
        }
        (None, _) | (_, None) => {
            // No layout hash - cannot memcpy safely
        }
        _ => {
            // Different layout hash
        }
    }
    
    // 3. Check if migration is available
    if new_api.migrate.is_some() && old.state_snapshot.is_some() {
        return ReloadType::Warm;
    }
    
    // 4. Fallback to cold reload
    ReloadType::Cold("No migration path")
}
```

---

## 8. Crash Recovery & Supervision

### Supervisor Configuration

```rust
pub struct IsolationConfig {
    /// Path to worker binary
    pub worker_binary: PathBuf,
    
    /// Heartbeat interval (default: 5s)
    pub heartbeat_interval: Duration,
    
    /// Heartbeat timeout - worker considered dead (default: 15s)
    pub heartbeat_timeout: Duration,
    
    /// Maximum restart attempts before giving up (default: 5)
    pub max_restarts: u32,
    
    /// Restart backoff base duration (default: 500ms)
    pub restart_backoff: Duration,
    
    /// Enable IPC debug logging
    pub debug_ipc: bool,
}
```

### Hard Timeout Policy

**Every operation has a hard deadline. No exceptions.**

```rust
// Snapshot request: 5 second timeout
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);

// Reload operation: 10 second timeout
const RELOAD_TIMEOUT: Duration = Duration::from_secs(10);

// Quiescence check: 30 second timeout
pub const QUIESCENCE_HARD_TIMEOUT: Duration = Duration::from_secs(30);

// If timeout exceeded: SIGKILL worker, restart fresh
fn force_kill_and_restart(&mut self, reason: &str) -> Result<(), String> {
    eprintln!("[Supervisor] Force killing worker: {}", reason);
    
    if let Some(mut worker) = self.worker.take() {
        #[cfg(unix)]
        unsafe { libc::kill(worker.pid as i32, libc::SIGKILL); }
        
        let _ = worker.child.wait();
    }
    
    self.handle_crash()  // Spawn new worker, restore state
}
```

### Crash Recovery Flow

```
1. Worker crashes (SIGSEGV, timeout, etc.)
2. Supervisor detects via:
   - Child process exit
   - Heartbeat timeout
   - IPC read error
3. Supervisor increments restart_count
4. If restart_count < max_restarts:
   a. Apply exponential backoff
   b. Spawn new worker process
   c. Send LoadModule with saved state_snapshot
   d. Worker restores from snapshot
5. If restart_count >= max_restarts:
   - Report fatal error to gateway
   - Require manual intervention
```

---

## 9. DWARF-Based Layout Extraction

### Overview

The layout hash is extracted from **DWARF debug information** embedded in the compiled binary. This provides ground truth about struct layout.

### Implementation

```rust
fn extract_layout_hash_from_dwarf(
    mmap: &Mmap,
    obj: &object::File,
    state_size: usize,
) -> Option<u64> {
    // 1. Load DWARF sections
    let debug_abbrev = obj.section_by_name(".debug_abbrev")?.data().ok()?;
    let debug_info = obj.section_by_name(".debug_info")?.data().ok()?;
    let debug_str = obj.section_by_name(".debug_str").and_then(|s| s.data().ok());
    
    // 2. Parse DWARF using gimli
    let dwarf = gimli::Dwarf {
        debug_abbrev: gimli::DebugAbbrev::new(debug_abbrev, endian),
        debug_info: gimli::DebugInfo::new(debug_info, endian),
        debug_str: gimli::DebugStr::new(debug_str.unwrap_or(&[]), endian),
        // ... other sections
    };
    
    // 3. Find struct types matching state_size
    let mut iter = dwarf.units();
    while let Ok(Some(header)) = iter.next() {
        let unit = dwarf.unit(header).ok()?;
        let mut entries = unit.entries(&abbrevs);
        
        while let Ok(Some((_, entry))) = entries.next_dfs() {
            if entry.tag() == gimli::DW_TAG_structure_type {
                // Check DW_AT_byte_size matches state_size
                if let Some(size) = entry.attr_value(DW_AT_byte_size) {
                    if size == state_size {
                        // Found matching struct - compute hash
                        return Some(compute_struct_hash(&entry));
                    }
                }
            }
        }
    }
    
    None  // No DWARF info or no matching struct
}
```

### Build ID Extraction

```rust
fn extract_build_id_from_elf(obj: &object::File) -> Option<String> {
    // Parse .note.gnu.build-id section
    let section = obj.section_by_name(".note.gnu.build-id")?;
    let data = section.data().ok()?;
    
    // Note format: namesz(4) + descsz(4) + type(4) + name + desc
    let namesz = u32::from_le_bytes(data[0..4]) as usize;
    let descsz = u32::from_le_bytes(data[4..8]) as usize;
    let aligned_namesz = (namesz + 3) & !3;
    let desc_offset = 12 + aligned_namesz;
    
    let build_id = &data[desc_offset..desc_offset + descsz];
    Some(hex::encode(build_id))
}
```

---

## 10. Security Model

### Threat Model

| Threat | Mitigation | Status |
|--------|------------|--------|
| Malicious module code | Process isolation (sandbox) | Implemented |
| Memory corruption | Layout hash verification | Implemented |
| Resource exhaustion | setrlimit, watchdog | Partial |
| Sandbox escape | seccomp-bpf, namespaces | Planned |
| Network exfiltration | No direct socket access | Planned |

### Process Isolation Guarantees

```
┌─────────────────────────────────────────────────────────────────┐
│ SUPERVISOR PROCESS (TRUSTED)                                    │
│ - No direct execution of plugin code                            │
│ - Only IPC communication with worker                            │
│ - Can survive worker crashes                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                    IPC (binary frames)
                              │
┌─────────────────────────────────────────────────────────────────┐
│ WORKER PROCESS (UNTRUSTED)                                      │
│ - Executes plugin code                                          │
│ - Can be killed at any time                                     │
│ - State preserved via snapshots                                 │
│ - Future: seccomp-bpf syscall filtering                         │
└─────────────────────────────────────────────────────────────────┘
```

### Resource Limits (Planned)

```rust
pub struct ResourceLimits {
    pub max_memory: u64,        // 2GB default
    pub max_cpu_time: u64,      // Unlimited (watchdog instead)
    pub max_file_size: u64,     // 100MB default
    pub max_open_files: u32,    // 256 default
    pub allow_network: bool,    // false default
}
```

---

## 11. Performance Characteristics

### Latency Breakdown

| Operation | Time | Notes |
|-----------|------|-------|
| DWARF parsing | 5-20ms | Once per load, cached |
| Fingerprint comparison | <1ms | In-memory hash comparison |
| State serialization | 1-50ms | Depends on state size |
| IPC round-trip | 1-5ms | Local pipes |
| Module load (dlopen) | 10-50ms | Depends on library size |
| Process spawn | 50-100ms | Fork + exec |

### Memory Usage

| Component | Memory | Notes |
|-----------|--------|-------|
| Supervisor | ~10MB | Event loop, snapshot storage |
| Worker | ~20MB + modules | SDL2, modules, state |
| State snapshot | Variable | MsgPack compressed |
| IPC buffers | ~1MB | Read/write buffers |

### Optimization Tips

1. **Compile with debug info** (`-g`) for layout hash extraction
2. **Use incremental builds** to minimize compile time
3. **Keep state small** (<1MB) for fast serialization
4. **Prefer Safe reloads** by keeping struct layouts stable
5. **Use state versioning** to enable warm reloads

---

## 12. Integration Guide

### Minimal Plugin Implementation

```c
// plugin.c
#include <stdint.h>
#include <stdbool.h>

// State struct - keep stable for Safe reloads
typedef struct {
    float x, y;
    float velocity_x, velocity_y;
    uint32_t frame_count;
} PluginState;

// Export table
typedef struct {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t state_version;
    uint64_t abi_fingerprint;
    uint32_t state_size_bytes;
    uint32_t state_align_bytes;
    
    bool (*init)(void* state, const void* runner_api);
    void (*update)(void* state, double dt);
    bool (*save_state)(const void* state, uint8_t** out, size_t* len);
    bool (*load_state)(void* state, const uint8_t* data, size_t len);
} HotApi;

// Implementation
static bool plugin_init(void* state, const void* runner_api) {
    PluginState* s = (PluginState*)state;
    s->x = 400.0f;
    s->y = 300.0f;
    s->velocity_x = 1.0f;
    s->velocity_y = 0.5f;
    s->frame_count = 0;
    return true;
}

static void plugin_update(void* state, double dt) {
    PluginState* s = (PluginState*)state;
    s->x += s->velocity_x * dt * 60.0f;
    s->y += s->velocity_y * dt * 60.0f;
    s->frame_count++;
}

// Single export point
static const HotApi API = {
    .struct_size = sizeof(HotApi),
    .abi_version = 1,
    .state_version = 1,
    .abi_fingerprint = 0x12345678,
    .state_size_bytes = sizeof(PluginState),
    .state_align_bytes = alignof(PluginState),
    .init = plugin_init,
    .update = plugin_update,
    .save_state = NULL,  // Optional
    .load_state = NULL,  // Optional
};

__attribute__((visibility("default")))
const HotApi* hot_get_api(void) {
    return &API;
}
```

### Build Command

```bash
# With debug info for layout hash extraction
gcc -shared -fPIC -g -O2 \
    -o libplugin.so plugin.c \
    -Wl,--build-id
```

### Gateway Integration

```javascript
// Node.js gateway example
const { spawn } = require('child_process');

const supervisor = spawn('./synthi-runner', [], {
    stdio: ['pipe', 'pipe', 'inherit']
});

// Send load command
supervisor.stdin.write('load core /path/to/libcore.so\n');

// Handle responses
supervisor.stdout.on('data', (data) => {
    const response = JSON.parse(data.toString());
    console.log('Supervisor:', response);
});

// Hot reload on file change
watcher.on('change', (path) => {
    supervisor.stdin.write(`reload core ${path}\n`);
});
```

---

## Appendix: Error Codes

| Code | Meaning | Recovery |
|------|---------|----------|
| `E_NO_LAYOUT_HASH` | DWARF info missing | Compile with `-g` |
| `E_LAYOUT_MISMATCH` | Struct layout changed | Use migration or cold reload |
| `E_MIGRATION_FAILED` | migrate() returned false | Check migration code |
| `E_TIMEOUT` | Operation exceeded deadline | Worker killed, restarted |
| `E_MAX_RESTARTS` | Too many crashes | Manual intervention required |
| `E_IPC_ERROR` | Communication failure | Worker killed, restarted |

---

*Document generated: December 2025*  
*System version: Synthi AI-HMR 2.0*
