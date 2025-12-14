# Synthi Plugin ABI Specification v1.0

## Overview

This document defines the **frozen** Application Binary Interface (ABI) contract between the Synthi Runner (host) and dynamically loaded plugin modules (core, gui). This contract enables Next.js-like hot module replacement (HMR) where:

- GUI changes rebuild only the GUI module
- Core state is preserved across GUI reloads
- Compilation errors don't crash the running application

## Module Slots

The runner maintains exactly **three independent module slots**:

| Slot | Purpose | State Ownership | Can Reload Independently |
|------|---------|-----------------|--------------------------|
| `core` | Business logic, game state, simulation | `CoreState` | No (GUI must reload too) |
| `gui` | Rendering, visual presentation | `GuiState` | **Yes** (core continues) |
| `main` | Legacy single-module mode | `AppState` | N/A (replaces both) |

### Mode Switching Rules

- Loading `main` unloads both `core` and `gui`
- Loading `core` or `gui` unloads `main`
- `core` and `gui` can coexist

---

## ABI Version Constants

```c
#define SYNTHI_CORE_ABI_VERSION 1
#define SYNTHI_GUI_ABI_VERSION 1

// Magic numbers for struct validation
#define CORE_STATE_MAGIC 0xDEADBEEF
#define GUI_STATE_MAGIC  0x60108EEF  // "GUI BEEF"
```

---

## State Structures

### CoreState (owned by core.so)

```c
typedef struct CoreState {
    // === ABI HEADER (MUST BE FIRST, DO NOT REORDER) ===
    uint32_t magic;           // Must be CORE_STATE_MAGIC (0xDEADBEEF)
    uint32_t struct_size;     // sizeof(CoreState)
    uint32_t abi_version;     // SYNTHI_CORE_ABI_VERSION
    
    // === RUNTIME FLAGS ===
    int running;              // 1 = running, 0 = should exit
    int paused;               // 1 = paused, 0 = active
    
    // === APPLICATION STATE (user-defined fields below) ===
    // ... user adds fields here ...
} CoreState;
```

### GuiState (owned by gui.so)

```c
typedef struct GuiState {
    // === ABI HEADER (MUST BE FIRST, DO NOT REORDER) ===
    uint32_t magic;           // Must be GUI_STATE_MAGIC (0x60108EEF)
    uint32_t struct_size;     // sizeof(GuiState)
    uint32_t abi_version;     // SYNTHI_GUI_ABI_VERSION
    
    // === RENDERER (provided by runner) ===
    SDL_Renderer* renderer;   // Owned by runner, stored here for convenience
    
    // === CORE REFERENCE (READ-ONLY) ===
    CoreState* core;          // Pointer to core state, GUI must NOT modify
    
    // === VIEW STATE (GUI-only, can reset on reload) ===
    float fade_alpha;         // Animation state
    float hover_time;         // UI state
    // ... user adds view fields here ...
} GuiState;
```

### CoreAPI (vtable exported by core)

```c
typedef struct CoreAPI {
    uint32_t version;                      // API version for compatibility
    CoreState* (*get_state)(void);         // Get current core state
    void (*pause)(void);                   // Pause simulation
    void (*resume)(void);                  // Resume simulation
    // Extensible: add more function pointers as needed
} CoreAPI;
```

---

## Required Exports by Module

### Core Module (`core.so`)

| Symbol | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `core_on_load` | `CoreState* (CoreState* prev, void* host_ctx)` | **Yes** | Initialize or migrate state |
| `core_on_update` | `void (CoreState* state, double dt)` | **Yes** | Called every frame |
| `core_on_event` | `void (CoreState* state, SDL_Event* event)` | No | Handle input events |
| `core_on_unload` | `void (CoreState* state)` | No | Cleanup before unload |
| `core_get_api` | `CoreAPI* (void)` | **Yes** | Return API vtable for GUI |
| `core_on_save_state` | `char* (CoreState* state)` | No | Serialize state to JSON |
| `core_on_load_from_json` | `CoreState* (const char* json)` | No | Deserialize state from JSON |
| `core_get_abi_version` | `uint32_t (void)` | No | Return SYNTHI_CORE_ABI_VERSION |

### GUI Module (`gui.so`)

| Symbol | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `gui_on_load` | `GuiState* (GuiState* prev, void* renderer, CoreAPI* api)` | **Yes** | Initialize GUI with core API |
| `gui_on_render` | `void (GuiState* state)` | **Yes** | Render frame (do NOT call SDL_RenderPresent) |
| `gui_on_event` | `void (GuiState* state, SDL_Event* event)` | No | Handle GUI-specific events |
| `gui_on_unload` | `void (GuiState* state)` | No | Cleanup before unload |
| `gui_on_save_state` | `char* (GuiState* state)` | No | Serialize GUI state to JSON |
| `gui_on_load_from_json` | `GuiState* (const char* json)` | No | Deserialize GUI state |
| `gui_get_abi_version` | `uint32_t (void)` | No | Return SYNTHI_GUI_ABI_VERSION |

### Legacy Main Module (`main.so`) - Backward Compatibility

| Symbol | Signature | Required | Description |
|--------|-----------|----------|-------------|
| `on_load` | `void* (void* prev, void* host_ctx)` | Yes | Initialize state |
| `on_update` | `void (void* state, double dt)` | Yes | Called every frame |
| `on_event` | `void (void* state, SDL_Event* event)` | No | Handle events |
| `on_unload` | `void (void* state)` | No | Cleanup |

---

## Runner Behavior

### Load Sequence

```
load(slot, path):
  1. Open new library (old continues running)
  2. Validate required symbols for slot
  3. Check ABI version compatibility
  4. IF incompatible:
     - For GUI: reject load, keep old GUI, log error
     - For Core: force full reload (core + gui)
  5. Save state from old module (if exists)
  6. Call new module's *_on_load with:
     - Core: (prev_state, renderer)
     - GUI: (prev_state, renderer, core_api)
  7. ATOMIC: Replace slot's (lib, state, path)
  8. Call old module's *_on_unload (deferred)
  9. Drop old library handle
```

### Event Dispatch

```
on_sdl_event(event):
  1. IF core loaded: core_on_event(core_state, event)
  2. IF gui loaded: gui_on_event(gui_state, event)
```

### Update Loop

```
on_frame(dt):
  1. IF core loaded: core_on_update(core_state, dt)
  2. IF gui loaded: gui_on_render(gui_state)
  3. SDL_RenderPresent (runner owns this)
```

---

## ABI Compatibility Rules

### Version Checking

```c
// Runner checks on load:
if (module_abi_version > RUNNER_SUPPORTED_ABI) {
    // Reject: module is newer than runner understands
    return LOAD_REJECTED;
}
if (module_abi_version < RUNNER_MIN_ABI) {
    // Reject: module is too old
    return LOAD_REJECTED;
}
```

### Struct Size Validation

```c
// On state migration:
if (prev_state->magic != EXPECTED_MAGIC) {
    // Fresh init, don't migrate
    return create_fresh_state();
}
if (prev_state->struct_size != sizeof(CurrentState)) {
    // Size changed, attempt field-by-field migration or reset
    return migrate_or_reset(prev_state);
}
// Safe to copy
```

### Breaking vs Non-Breaking Changes

| Change Type | Core Impact | GUI Impact |
|-------------|-------------|------------|
| Add field to end of CoreState | Non-breaking (if struct_size checked) | Non-breaking |
| Remove/reorder CoreState field | **BREAKING** → Full reload | Full reload |
| Change CoreAPI function signature | **BREAKING** → Full reload | Full reload |
| Add field to GuiState | Non-breaking | Non-breaking |
| Change gui_on_render signature | N/A | **BREAKING** → GUI reload fails |

---

## Rebuild Decision Matrix

| File Changed | Rebuild | Load Commands |
|--------------|---------|---------------|
| `shared.h` | Both | `load core ...` then `load gui ...` |
| `core.cpp` | Core + GUI | `load core ...` then `load gui ...` |
| `gui.cpp` | GUI only | `load gui ...` |
| `core.cpp` (ABI unchanged) | Core only | `load core ...` (GUI continues) |

### Determining ABI Change

Core ABI changed if any of:
- `CoreState` struct layout changed
- `CoreAPI` struct layout changed  
- `core_on_load` / `core_on_update` / `core_get_api` signature changed

GUI ABI changed if any of:
- `GuiState` struct layout changed
- `gui_on_load` / `gui_on_render` signature changed

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Compile error | Old module continues, error streamed to UI |
| Symbol missing | Load rejected, old module continues |
| ABI version mismatch | Load rejected or full reload (policy) |
| `*_on_load` returns NULL | Load rejected, old module continues |
| `*_on_load` crashes | Runner catches, old module continues (if possible) |

---

## Example Implementation

### shared.h

```c
#ifndef SHARED_H
#define SHARED_H

#include <SDL2/SDL.h>
#include <stdint.h>

#define SYNTHI_CORE_ABI_VERSION 1
#define SYNTHI_GUI_ABI_VERSION 1
#define CORE_STATE_MAGIC 0xDEADBEEF
#define GUI_STATE_MAGIC  0x60108EEF

typedef struct CoreState {
    uint32_t magic;
    uint32_t struct_size;
    uint32_t abi_version;
    int running;
    int paused;
    
    // User state
    int x, y;
    int dx, dy;
} CoreState;

typedef struct GuiState {
    uint32_t magic;
    uint32_t struct_size;
    uint32_t abi_version;
    SDL_Renderer* renderer;
    struct CoreState* core;
} GuiState;

typedef struct CoreAPI {
    uint32_t version;
    CoreState* (*get_state)(void);
    void (*pause)(void);
    void (*resume)(void);
} CoreAPI;

#endif
```

### core.cpp

```cpp
#include "shared.h"

static CoreState g_core_state = {0};
static CoreAPI g_core_api = {0};

extern "C" uint32_t core_get_abi_version(void) {
    return SYNTHI_CORE_ABI_VERSION;
}

extern "C" CoreAPI* core_get_api(void) {
    g_core_api.version = 1;
    g_core_api.get_state = []() -> CoreState* { return &g_core_state; };
    g_core_api.pause = []() { g_core_state.paused = 1; };
    g_core_api.resume = []() { g_core_state.paused = 0; };
    return &g_core_api;
}

extern "C" CoreState* core_on_load(CoreState* prev, void* host_ctx) {
    if (prev && prev->magic == CORE_STATE_MAGIC && 
        prev->struct_size == sizeof(CoreState)) {
        g_core_state = *prev;
    } else {
        g_core_state.magic = CORE_STATE_MAGIC;
        g_core_state.struct_size = sizeof(CoreState);
        g_core_state.abi_version = SYNTHI_CORE_ABI_VERSION;
        g_core_state.running = 1;
        // Initialize user fields...
    }
    return &g_core_state;
}

extern "C" void core_on_update(CoreState* state, double dt) {
    if (state->paused) return;
    state->x += state->dx;
    // ... business logic
}

extern "C" void core_on_event(CoreState* state, SDL_Event* event) {
    if (event->type == SDL_KEYDOWN && event->key.keysym.sym == SDLK_SPACE) {
        state->paused = !state->paused;
    }
}
```

### gui.cpp

```cpp
#include "shared.h"

static GuiState g_gui_state = {0};

extern "C" uint32_t gui_get_abi_version(void) {
    return SYNTHI_GUI_ABI_VERSION;
}

extern "C" GuiState* gui_on_load(GuiState* prev, void* renderer, CoreAPI* api) {
    if (prev && prev->magic == GUI_STATE_MAGIC) {
        g_gui_state = *prev;
    } else {
        g_gui_state.magic = GUI_STATE_MAGIC;
        g_gui_state.struct_size = sizeof(GuiState);
        g_gui_state.abi_version = SYNTHI_GUI_ABI_VERSION;
    }
    g_gui_state.renderer = (SDL_Renderer*)renderer;
    g_gui_state.core = api ? api->get_state() : NULL;
    return &g_gui_state;
}

extern "C" void gui_on_render(GuiState* state) {
    if (!state || !state->renderer || !state->core) return;
    
    SDL_SetRenderDrawColor(state->renderer, 0, 0, 0, 255);
    SDL_RenderClear(state->renderer);
    
    // Read from core (never modify!)
    int x = state->core->x;
    int y = state->core->y;
    
    SDL_Rect rect = {x, y, 50, 50};
    SDL_SetRenderDrawColor(state->renderer, 255, 0, 0, 255);
    SDL_RenderFillRect(state->renderer, &rect);
    
    // DO NOT call SDL_RenderPresent - runner does this
}
```

---

## Host KV API (v1.0)

The Host KV API provides persistent key-value storage that survives hot reloads. This enables "Fast Refresh-like" state preservation where changing code doesn't lose application state.

### Key Features

- **Per-namespace schema validation**: Prevents stale state corruption
- **Automatic namespace reset**: When schema changes, only affected namespace is cleared
- **Quotas**: Prevent runaway storage (1MB per value, 20MB per module)
- **Zero-copy hot reload**: KV data survives module reload without serialization

### Optional Host KV Exports

Add these exports to enable Host KV support:

| Slot | Schema Length | Schema Table | Host-aware Load |
|------|---------------|--------------|-----------------|
| Core | `core_host_kv_schemas_len` | `core_host_kv_schemas` | `core_on_load_host` |
| GUI | `gui_host_kv_schemas_len` | `gui_host_kv_schemas` | `gui_on_load_host` |
| Main | `host_kv_schemas_len` | `host_kv_schemas` | `on_load_host` |

### Runner Selection Rules

1. If `*_on_load_host` exists, call it with `SynthiHostContextV1*`
2. Else call existing `*_on_load` unchanged (renderer-pointer ABI intact)
3. Schema exports are read regardless of load function used

### SynthiHostContextV1 (passed to *_on_load_host)

```c
typedef struct SynthiHostContextV1 {
    uint32_t host_api_version;      // Must be 1
    const HostKvApiV1* kv;          // KV API vtable
    const char* session_id;         // Session identifier
    uint32_t session_id_len;
    uint32_t module_slot;           // 0=core, 1=gui, 2=main
    void* window;                   // SDL_Window* (optional)
    void* renderer;                 // SDL_Renderer*
    void* reserved[8];              // Future expansion
} SynthiHostContextV1;
```

### HostKvApiV1 (vtable)

```c
typedef struct HostKvApiV1 {
    uint32_t version;  // Must be 1
    
    // Set bytes: returns 0=OK, 2=INVALID_ARG, 3=QUOTA_EXCEEDED
    int (*set_bytes)(ctx, ns, key, data, len);
    
    // Get bytes: returns 0=OK, 1=NOT_FOUND, allocates buffer
    int (*get_bytes)(ctx, ns, key, &out, &out_len);
    
    // Delete key: returns 0=OK (idempotent)
    int (*delete_key)(ctx, ns, key);
    
    // Clear namespace: returns 0=OK
    int (*clear_namespace)(ctx, ns);
    
    // Get/set schema (optional)
    int (*get_schema)(ctx, ns, &out_schema);
    int (*set_schema)(ctx, ns, schema);
    
    // Memory management
    void* (*host_alloc)(size);
    void (*host_free)(ptr);
    const char* (*last_error)(void);
} HostKvApiV1;
```

### SynthiNamespaceSchemaV1 (for schema table export)

```c
typedef struct SynthiNamespaceSchemaV1 {
    const char* ns;       // NUL-terminated namespace name
    uint64_t schema_id;   // Schema version/hash
} SynthiNamespaceSchemaV1;
```

### Return Codes

| Code | Name | Description |
|------|------|-------------|
| 0 | OK | Success |
| 1 | NOT_FOUND | Key doesn't exist |
| 2 | INVALID_ARG | Bad ns/key, undeclared namespace |
| 3 | QUOTA_EXCEEDED | Size/count limit exceeded |
| 4 | INTERNAL_ERROR | Unexpected error |

### Namespace/Key Validation

- Allowed chars: `[a-zA-Z0-9._-]`
- Max namespace length: 64 bytes
- Max key length: 256 bytes
- No `/` or `\` (avoid path-like keys)

### Schema Rules

1. Module declares namespaces via schema table exports
2. On load/reload, runner reads schema table
3. For each namespace:
   - If no stored schema: store new schema ID
   - If stored schema != new schema: **clear namespace, store new**
   - If schemas match: preserve data
4. Writing to undeclared namespace returns `INVALID_ARG`

### Example: Core Module with Host KV

```c
#include "synthi_host_kv.h"

static const SynthiNamespaceSchemaV1 g_schemas[] = {
    { "app",      1 },  // Change to 2 when AppState struct changes
    { "settings", 1 },
};

SYNTHI_EXPORT uint32_t core_host_kv_schemas_len(void) {
    return sizeof(g_schemas) / sizeof(g_schemas[0]);
}

SYNTHI_EXPORT const SynthiNamespaceSchemaV1* core_host_kv_schemas(void) {
    return g_schemas;
}

SYNTHI_EXPORT void* core_on_load_host(void* prev, const SynthiHostContextV1* ctx) {
    CoreState* state = (CoreState*)prev;
    if (!state) {
        state = malloc(sizeof(CoreState));
        memset(state, 0, sizeof(CoreState));
        
        // Try to restore from KV
        uint8_t* data;
        uint32_t len;
        if (ctx->kv->get_bytes(ctx, "app", "state", &data, &len) == 0) {
            if (len == sizeof(CoreState)) {
                memcpy(state, data, len);
            }
            ctx->kv->host_free(data);
        }
    }
    
    state->renderer = ctx->renderer;
    return state;
}

// Save state periodically or on specific events
void save_state(CoreState* state, const SynthiHostContextV1* ctx) {
    ctx->kv->set_bytes(ctx, "app", "state", (uint8_t*)state, sizeof(CoreState));
}
```

---

## Changelog

- **v1.0** (2024-12-12): Initial frozen specification
- **v1.1** (2024-12-12): Added Host KV API for persistent state
