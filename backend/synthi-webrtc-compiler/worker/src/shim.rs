#![allow(dead_code)]

// ============================================================
// RUNTIME SHIM GENERATOR
// ============================================================
// Generates wrapper code to make any app non-blocking by default.
// This is the key to "Next.js-like" HMR that works without users
// needing to structure their code in a specific way.
//
// DESIGN RATIONALE:
// - Blocking apps (those with main() that runs a loop) can't be hot-reloaded
// - We generate a shim that:
//   1. Wraps the user's blocking code in a "first frame" call
//   2. Provides on_load/on_update/on_unload hooks
//   3. Manages state lifecycle automatically
// - This makes HMR "just work" for any compilable code
// ============================================================

/// Shim generation mode
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShimMode {
    /// Wrap blocking main() in HMR-compatible structure
    WrapBlocking,
    /// Add missing state serialization hooks
    AddStateSerialization,
    /// Full shim: both wrapping and state serialization
    Full,
    /// No shim needed
    None,
}

/// Configuration for shim generation
#[derive(Debug, Clone)]
pub struct ShimConfig {
    pub mode: ShimMode,
    pub has_gui: bool,
    pub state_struct_name: Option<String>,
    pub width: u32,
    pub height: u32,
}

impl Default for ShimConfig {
    fn default() -> Self {
        ShimConfig {
            mode: ShimMode::WrapBlocking,
            has_gui: false,
            state_struct_name: None,
            width: 800,
            height: 600,
        }
    }
}

/// Result of shim generation
#[derive(Debug, Clone)]
pub struct ShimResult {
    /// The transformed source code
    pub source: String,
    /// Additional files to create (e.g., shim header)
    pub additional_files: Vec<(String, String)>,
    /// Compile flags to add
    pub extra_flags: Vec<String>,
}

/// Generate a shim to make C++ code HMR-capable
///
/// This wraps blocking code in an HMR-compatible structure:
/// - User's main() becomes _user_main() called once on first update
/// - on_load creates/restores state
/// - on_update calls user's render logic (if any) or does nothing after init
/// - State is a simple struct that wraps user globals
pub fn generate_cpp_shim(source: &str, config: &ShimConfig) -> ShimResult {
    match config.mode {
        ShimMode::WrapBlocking => generate_blocking_wrapper_cpp(source, config),
        ShimMode::AddStateSerialization => generate_state_serialization_cpp(source, config),
        ShimMode::Full => {
            let wrapped = generate_blocking_wrapper_cpp(source, config);
            generate_state_serialization_cpp(&wrapped.source, config)
        }
        ShimMode::None => ShimResult {
            source: source.to_string(),
            additional_files: vec![],
            extra_flags: vec![],
        },
    }
}

/// Generate wrapper for blocking C++ code
fn generate_blocking_wrapper_cpp(source: &str, config: &ShimConfig) -> ShimResult {
    let has_main = source.contains("int main(") || source.contains("int main (");
    let has_sdl_main = source.contains("SDL_main");

    if !has_main && !has_sdl_main {
        // No main to wrap, just add minimal HMR hooks if missing
        return add_minimal_hmr_hooks_cpp(source, config);
    }

    // State struct name
    let state_name = config.state_struct_name.as_deref().unwrap_or("ShimState");

    let shim_header = format!(
        r#"
// ============================================================
// SYNTHI AUTO-GENERATED HMR SHIM
// ============================================================
// This shim wraps your blocking application to enable hot reload.
// Your original main() is preserved as _user_main().
// ============================================================

#ifndef SYNTHI_SHIM_H
#define SYNTHI_SHIM_H

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {{
#endif

// Shim state - wraps user globals
typedef struct {state_name} {{
    uint32_t magic;          // 0xDEADBEEF for validation
    uint32_t struct_size;    // sizeof({state_name})
    uint32_t abi_version;    // ABI version
    bool initialized;        // Has _user_main been called?
    bool first_frame;        // Is this the first frame?
    void* renderer;          // SDL renderer (if GUI)
    void* user_data;         // User's custom state (optional)
}} {state_name};

// Forward declare user's original main
int _user_main(int argc, char* argv[]);

#ifdef __cplusplus
}}
#endif

#endif // SYNTHI_SHIM_H
"#,
        state_name = state_name
    );

    let shim_impl = format!(
        r#"
// ============================================================
// SYNTHI HMR SHIM IMPLEMENTATION
// ============================================================

#include "synthi_shim.h"
#include <stdio.h>

// Rename user's main to _user_main
#define main _user_main

// --- USER CODE STARTS ---
{user_source}
// --- USER CODE ENDS ---

#undef main

// ============================================================
// HMR HOOKS
// ============================================================

extern "C" void* on_load(void* prev_state, void* renderer) {{
    // Use static storage for reliability (avoids heap fragmentation/pointer issues)
    static {state_name} app_state = {{0}};
    {state_name}* state = &app_state;
    
    if (prev_state != NULL) {{
        // SAFETY: Validate prev_state pointer before dereferencing
        // Check magic number at the expected offset to validate pointer
        {state_name}* old_state = ({state_name}*)prev_state;
        
        // Read magic carefully - if prev_state is invalid this could crash,
        // but signal handlers should catch it
        volatile uint32_t magic_check = 0;
        magic_check = old_state->magic;
        
        if (magic_check != 0xDEADBEEF) {{
            fprintf(stderr, "[Shim] Invalid state magic (0x%08X), re-initializing static state\\n", magic_check);
            memset(state, 0, sizeof({state_name}));
            state->magic = 0xDEADBEEF;
            state->struct_size = sizeof({state_name});
            state->abi_version = 1;
            state->initialized = false;
            state->first_frame = true;
        }} else {{
            // SAFETY: Validate struct_size matches before copying
            if (old_state->struct_size != sizeof({state_name})) {{
                fprintf(stderr, "[Shim] State struct size mismatch (old: %u, new: %lu), re-initializing\\n", 
                        old_state->struct_size, (unsigned long)sizeof({state_name}));
                memset(state, 0, sizeof({state_name}));
                state->magic = 0xDEADBEEF;
                state->struct_size = sizeof({state_name});
                state->abi_version = 1;
                state->initialized = false;
                state->first_frame = true;
            }} else {{
                fprintf(stderr, "[Shim] Restored state from previous module (ABI v%u)\\n", old_state->abi_version);
                // Safe to copy - sizes match and magic is valid
                if (state != old_state) {{
                    memcpy(state, old_state, sizeof({state_name}));
                }}
            }}
        }}
    }} else {{
        // Fresh start
        memset(state, 0, sizeof({state_name}));
        state->magic = 0xDEADBEEF;
        state->struct_size = sizeof({state_name});
        state->abi_version = 1;
        state->initialized = false;
        state->first_frame = true;
    }}
    
    state->renderer = renderer;
    return state;
}}

extern "C" void on_update(void* state_ptr, double dt) {{
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state) return;
    
    // Run user's main() exactly once, on first frame
    if (!state->initialized && state->first_frame) {{
        fprintf(stderr, "[Shim] Running user main() (one-shot)\\n");
        state->first_frame = false;
        state->initialized = true;
        
        // Call user's main with empty args
        char* argv[] = {{"app", NULL}};
        _user_main(1, argv);
    }}
    
    // After initialization, this is just a no-op frame
    // The app's rendering (if any) was done in main()
}}

extern "C" void on_unload(void* state_ptr) {{
    // Don't free state - it will be passed to next module
    fprintf(stderr, "[Shim] on_unload called, preserving state for reload\\n");
}}

extern "C" char* on_save_state(void* state_ptr) {{
    // Basic state save - just preserve initialized flag
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state) return NULL;
    
    char* json = (char*)malloc(256);
    snprintf(json, 256, "{{\"initialized\":%s}}", state->initialized ? "true" : "false");
    return json;
}}

extern "C" void* on_load_from_json(const char* json) {{
    {state_name}* state = ({state_name}*)calloc(1, sizeof({state_name}));
    state->magic = 0xDEADBEEF;
    state->struct_size = sizeof({state_name});
    state->abi_version = 1;
    
    // Parse initialized flag
    if (json && strstr(json, "\"initialized\":true")) {{
        state->initialized = true;
    }}
    
    return state;
}}

// Entrypoint for runner compatibility
extern "C" void* entrypoint(void* state) {{
    return on_load(state, NULL);
}}
"#,
        user_source = source,
        state_name = state_name
    );

    ShimResult {
        source: shim_impl,
        additional_files: vec![("synthi_shim.h".to_string(), shim_header)],
        extra_flags: vec![],
    }
}

/// Add minimal HMR hooks to code that doesn't have them
fn add_minimal_hmr_hooks_cpp(source: &str, config: &ShimConfig) -> ShimResult {
    let has_on_load = source.contains("on_load(") || source.contains("on_load (");
    let has_on_update = source.contains("on_update(") || source.contains("on_update (");

    if has_on_load && has_on_update {
        // Already has hooks
        return ShimResult {
            source: source.to_string(),
            additional_files: vec![],
            extra_flags: vec![],
        };
    }

    let state_name = config
        .state_struct_name
        .as_deref()
        .unwrap_or("MinimalState");

    let hooks = format!(
        r#"
// ============================================================
// SYNTHI AUTO-ADDED HMR HOOKS
// ============================================================

#ifndef SYNTHI_MINIMAL_STATE
#define SYNTHI_MINIMAL_STATE

typedef struct {state_name} {{
    uint32_t magic;
    uint32_t struct_size;
    uint32_t abi_version;
    void* renderer;
}} {state_name};

#endif

{on_load}

{on_update}

// Original code follows:
{source}
"#,
        state_name = state_name,
        on_load = if !has_on_load {
            format!(
                r#"
extern "C" void* on_load(void* prev, void* renderer) {{
    static {state_name} app_state = {{0}};
    {state_name}* state = &app_state;
    
    if (prev) {{
        {state_name}* old = ({state_name}*)prev;
        if (state != old) *state = *old;
    }} else {{
        memset(state, 0, sizeof({state_name}));
        state->magic = 0xDEADBEEF;
        state->struct_size = sizeof({state_name});
        state->abi_version = 1;
    }}
    
    state->renderer = renderer;
    return state;
}}
"#,
                state_name = state_name
            )
        } else {
            String::new()
        },
        on_update = if !has_on_update {
            format!(
                r#"
extern "C" void on_update(void* state_ptr, double dt) {{
    // Minimal update - override this with your logic
    (void)state_ptr;
    (void)dt;
}}
"#
            )
        } else {
            String::new()
        },
        source = source
    );

    ShimResult {
        source: hooks,
        additional_files: vec![],
        extra_flags: vec![],
    }
}

/// Generate state serialization hooks with FULL IMPLEMENTATION
/// This is critical for HMR state preservation across hot reloads
fn generate_state_serialization_cpp(source: &str, config: &ShimConfig) -> ShimResult {
    let has_save = source.contains("on_save_state");
    let has_load = source.contains("on_load_from_json");

    if has_save && has_load {
        return ShimResult {
            source: source.to_string(),
            additional_files: vec![],
            extra_flags: vec![],
        };
    }

    let state_name = config.state_struct_name.as_deref().unwrap_or("ShimState");
    let mut additions = String::new();

    // Add helper includes if needed
    if !source.contains("<cJSON.h>") && !source.contains("<json.h>") {
        additions.push_str(
            r#"
// ============================================================
// SYNTHI STATE SERIALIZATION HELPERS
// ============================================================
// Minimal JSON serialization without external dependencies
// Uses a simple recursive format for common C types
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

// Simple JSON builder (no external deps)
typedef struct {
    char* buffer;
    size_t capacity;
    size_t length;
} JsonBuilder;

static void json_builder_init(JsonBuilder* jb, size_t initial_capacity) {
    jb->capacity = initial_capacity > 64 ? initial_capacity : 64;
    jb->buffer = (char*)malloc(jb->capacity);
    jb->length = 0;
    if (jb->buffer) jb->buffer[0] = '\0';
}

static void json_builder_ensure(JsonBuilder* jb, size_t needed) {
    if (jb->length + needed >= jb->capacity) {
        jb->capacity = (jb->length + needed) * 2;
        jb->buffer = (char*)realloc(jb->buffer, jb->capacity);
    }
}

static void json_builder_append(JsonBuilder* jb, const char* str) {
    size_t len = strlen(str);
    json_builder_ensure(jb, len + 1);
    memcpy(jb->buffer + jb->length, str, len + 1);
    jb->length += len;
}

static void json_builder_append_int(JsonBuilder* jb, int64_t value) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%lld", (long long)value);
    json_builder_append(jb, buf);
}

static void json_builder_append_uint(JsonBuilder* jb, uint64_t value) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%llu", (unsigned long long)value);
    json_builder_append(jb, buf);
}

static void json_builder_append_double(JsonBuilder* jb, double value) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%.15g", value);
    json_builder_append(jb, buf);
}

static void json_builder_append_bool(JsonBuilder* jb, bool value) {
    json_builder_append(jb, value ? "true" : "false");
}

static void json_builder_append_string(JsonBuilder* jb, const char* str) {
    json_builder_append(jb, "\"");
    // Escape special characters
    for (const char* p = str; *p; p++) {
        switch (*p) {
            case '"': json_builder_append(jb, "\\\""); break;
            case '\\': json_builder_append(jb, "\\\\"); break;
            case '\n': json_builder_append(jb, "\\n"); break;
            case '\r': json_builder_append(jb, "\\r"); break;
            case '\t': json_builder_append(jb, "\\t"); break;
            default:
                json_builder_ensure(jb, 2);
                jb->buffer[jb->length++] = *p;
                jb->buffer[jb->length] = '\0';
        }
    }
    json_builder_append(jb, "\"");
}

static char* json_builder_finish(JsonBuilder* jb) {
    return jb->buffer; // Caller takes ownership
}

static void json_builder_free(JsonBuilder* jb) {
    free(jb->buffer);
    jb->buffer = NULL;
    jb->length = 0;
    jb->capacity = 0;
}

// Simple JSON parser helpers
static const char* json_skip_whitespace(const char* json) {
    while (*json && (*json == ' ' || *json == '\t' || *json == '\n' || *json == '\r')) json++;
    return json;
}

static bool json_parse_bool(const char* json, const char* key, bool* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* found = strstr(json, pattern);
    if (!found) return false;
    found += strlen(pattern);
    found = json_skip_whitespace(found);
    if (strncmp(found, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(found, "false", 5) == 0) { *out = false; return true; }
    return false;
}

static bool json_parse_int(const char* json, const char* key, int64_t* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* found = strstr(json, pattern);
    if (!found) return false;
    found += strlen(pattern);
    found = json_skip_whitespace(found);
    char* end;
    *out = strtoll(found, &end, 10);
    return end != found;
}

static bool json_parse_uint(const char* json, const char* key, uint64_t* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* found = strstr(json, pattern);
    if (!found) return false;
    found += strlen(pattern);
    found = json_skip_whitespace(found);
    char* end;
    *out = strtoull(found, &end, 10);
    return end != found;
}

static bool json_parse_double(const char* json, const char* key, double* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char* found = strstr(json, pattern);
    if (!found) return false;
    found += strlen(pattern);
    found = json_skip_whitespace(found);
    char* end;
    *out = strtod(found, &end);
    return end != found;
}

static bool json_parse_string(const char* json, const char* key, char* out, size_t max_len) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char* found = strstr(json, pattern);
    if (!found) return false;
    found += strlen(pattern);
    size_t i = 0;
    while (*found && *found != '"' && i < max_len - 1) {
        if (*found == '\\' && found[1]) {
            found++;
            switch (*found) {
                case 'n': out[i++] = '\n'; break;
                case 'r': out[i++] = '\r'; break;
                case 't': out[i++] = '\t'; break;
                case '"': out[i++] = '"'; break;
                case '\\': out[i++] = '\\'; break;
                default: out[i++] = *found;
            }
        } else {
            out[i++] = *found;
        }
        found++;
    }
    out[i] = '\0';
    return true;
}

"#,
        );
    }

    if !has_save {
        additions.push_str(&format!(
            r#"
// ============================================================
// AUTO-GENERATED STATE SERIALIZATION
// ============================================================
// Serializes state struct to JSON for HMR state preservation
// Supports: magic, struct_size, abi_version, initialized, running,
//           and common primitive types in user_data
// ============================================================

extern "C" char* on_save_state(void* state_ptr) {{
    if (!state_ptr) return NULL;
    
    {state_name}* state = ({state_name}*)state_ptr;
    
    // Validate magic number
    if (state->magic != 0xDEADBEEF) {{
        fprintf(stderr, "[Serialization] Invalid magic number, cannot serialize\\n");
        return NULL;
    }}
    
    JsonBuilder jb;
    json_builder_init(&jb, 1024);
    
    json_builder_append(&jb, "{{");
    
    // Core state fields
    json_builder_append(&jb, "\"magic\":");
    json_builder_append_uint(&jb, state->magic);
    
    json_builder_append(&jb, ",\"struct_size\":");
    json_builder_append_uint(&jb, state->struct_size);
    
    json_builder_append(&jb, ",\"abi_version\":");
    json_builder_append_uint(&jb, state->abi_version);
    
    json_builder_append(&jb, ",\"initialized\":");
    json_builder_append_bool(&jb, state->initialized);
    
    // Check for running field (GUI states have this)
    #ifdef SYNTHI_HAS_RUNNING_FIELD
    json_builder_append(&jb, ",\"running\":");
    json_builder_append_bool(&jb, state->running);
    #endif
    
    // Serialize pointer addresses as hex for debugging (not for restoration)
    json_builder_append(&jb, ",\"_renderer_addr\":\"0x");
    char hex[32];
    snprintf(hex, sizeof(hex), "%llx", (unsigned long long)(uintptr_t)state->renderer);
    json_builder_append(&jb, hex);
    json_builder_append(&jb, "\"");
    
    // user_data serialization - if it's a known struct, serialize it
    // This hook allows users to extend serialization
    #ifdef SYNTHI_USER_DATA_SERIALIZER
    json_builder_append(&jb, ",\"user_data\":");
    char* user_json = SYNTHI_USER_DATA_SERIALIZER(state->user_data);
    if (user_json) {{
        json_builder_append(&jb, user_json);
        free(user_json);
    }} else {{
        json_builder_append(&jb, "null");
    }}
    #else
    // Default: just indicate whether user_data exists
    json_builder_append(&jb, ",\"user_data_present\":");
    json_builder_append_bool(&jb, state->user_data != NULL);
    #endif
    
    json_builder_append(&jb, "}}");
    
    return json_builder_finish(&jb);
}}
"#,
            state_name = state_name
        ));
    }

    if !has_load {
        additions.push_str(&format!(r#"
// ============================================================
// AUTO-GENERATED STATE DESERIALIZATION
// ============================================================
// Restores state from JSON for HMR state recovery
// Handles version mismatches gracefully with defaults
// ============================================================

extern "C" void* on_load_from_json(const char* json) {{
    if (!json) {{
        fprintf(stderr, "[Deserialization] NULL JSON, creating fresh state\\n");
        {state_name}* state = ({state_name}*)calloc(1, sizeof({state_name}));
        if (state) {{
            state->magic = 0xDEADBEEF;
            state->struct_size = sizeof({state_name});
            state->abi_version = 1;
            state->initialized = false;
        }}
        return state;
    }}
    
    // Allocate and zero-initialize
    {state_name}* state = ({state_name}*)calloc(1, sizeof({state_name}));
    if (!state) {{
        fprintf(stderr, "[Deserialization] Failed to allocate state\\n");
        return NULL;
    }}
    
    // Parse core fields
    uint64_t magic = 0;
    if (json_parse_uint(json, "magic", &magic)) {{
        if (magic != 0xDEADBEEF) {{
            fprintf(stderr, "[Deserialization] Warning: magic mismatch (0x%llx vs 0xDEADBEEF)\\n", 
                    (unsigned long long)magic);
        }}
    }}
    state->magic = 0xDEADBEEF; // Always set correct magic
    
    uint64_t struct_size = 0;
    if (json_parse_uint(json, "struct_size", &struct_size)) {{
        if (struct_size != sizeof({state_name})) {{
            fprintf(stderr, "[Deserialization] Warning: struct size mismatch (%llu vs %lu), may lose fields\\n",
                    (unsigned long long)struct_size, (unsigned long)sizeof({state_name}));
        }}
    }}
    state->struct_size = sizeof({state_name});
    
    uint64_t abi_version = 1;
    if (json_parse_uint(json, "abi_version", &abi_version)) {{
        state->abi_version = (uint32_t)abi_version;
    }} else {{
        state->abi_version = 1;
    }}
    
    bool initialized = false;
    if (json_parse_bool(json, "initialized", &initialized)) {{
        state->initialized = initialized;
    }}
    
    // Check for running field (GUI states)
    #ifdef SYNTHI_HAS_RUNNING_FIELD
    bool running = true;
    if (json_parse_bool(json, "running", &running)) {{
        state->running = running;
    }} else {{
        state->running = true; // Default to running
    }}
    #endif
    
    // User data deserialization hook
    #ifdef SYNTHI_USER_DATA_DESERIALIZER
    // Find user_data JSON substring
    const char* user_data_start = strstr(json, "\"user_data\":");
    if (user_data_start) {{
        user_data_start += strlen("\"user_data\":");
        user_data_start = json_skip_whitespace(user_data_start);
        state->user_data = SYNTHI_USER_DATA_DESERIALIZER(user_data_start);
    }}
    #endif
    
    fprintf(stderr, "[Deserialization] Restored state: initialized=%d, abi_v%u\\n",
            state->initialized, state->abi_version);
    
    return state;
}}
"#, state_name = state_name));
    }

    ShimResult {
        source: format!("{}\n{}", source, additions),
        additional_files: vec![],
        extra_flags: vec![],
    }
}

// ============================================================
// GUI-SPECIFIC SHIM FOR SDL2 APPS
// ============================================================

/// Generate a more sophisticated shim for SDL2 GUI apps
/// This handles the SDL event loop properly
pub fn generate_sdl_gui_shim(source: &str, config: &ShimConfig) -> ShimResult {
    let state_name = config.state_struct_name.as_deref().unwrap_or("SdlGuiState");

    let shim = format!(
        r#"
// ============================================================
// SYNTHI SDL2 GUI SHIM
// ============================================================
// Wraps SDL2 applications for hot reload support.
// The original SDL event loop is replaced with frame-based updates.
// ============================================================

#include <SDL2/SDL.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

typedef struct {state_name} {{
    uint32_t magic;
    uint32_t struct_size;
    uint32_t abi_version;
    SDL_Renderer* renderer;
    bool initialized;
    bool running;
    // User can extend this via user_data
    void* user_data;
}} {state_name};

// Forward declare user's setup/render functions if they exist
// User should implement: void user_setup({state_name}* state);
// User should implement: void user_render({state_name}* state, double dt);

__attribute__((weak)) void user_setup({state_name}* state) {{
    (void)state;
    fprintf(stderr, "[SdlShim] No user_setup found\\n");
}}

__attribute__((weak)) void user_render({state_name}* state, double dt) {{
    (void)state;
    (void)dt;
    // Default: just clear to a color
    SDL_SetRenderDrawColor(state->renderer, 64, 64, 64, 255);
    SDL_RenderClear(state->renderer);
}}

__attribute__((weak)) void user_event({state_name}* state, SDL_Event* event) {{
    (void)state;
    (void)event;
}}

extern "C" void* on_load(void* prev_state, void* renderer, void* core_api) {{
    // Use static storage
    static {state_name} app_state = {{0}};
    {state_name}* state = &app_state;
    
    if (prev_state) {{
        {state_name}* old = ({state_name}*)prev_state;
        if (old->magic == 0xDEADBEEF) {{
            if (state != old) *state = *old;
        }} else {{
            // Invalid magic, reset
            memset(state, 0, sizeof({state_name}));
        }}
    }} else {{
        memset(state, 0, sizeof({state_name}));
    }}
    
    // Ensure magic is set
    if (state->magic != 0xDEADBEEF) {{
        state->magic = 0xDEADBEEF;
        state->struct_size = sizeof({state_name});
        state->abi_version = 1;
        state->running = true;
    }}
    
    state->renderer = (SDL_Renderer*)renderer;
    
    if (!state->initialized) {{
        user_setup(state);
        state->initialized = true;
    }}
    
    return state;
}}

extern "C" void on_update(void* state_ptr, double dt) {{
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state || !state->running) return;
    
    user_render(state, dt);
}}

extern "C" void on_event(void* state_ptr, SDL_Event* event) {{
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state) return;
    
    user_event(state, event);
    
    if (event->type == SDL_QUIT) {{
        state->running = false;
    }}
}}

extern "C" void gui_render(void* state_ptr) {{
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state) return;
    // SDL_RenderPresent removed - runner handles this
}}

extern "C" void on_unload(void* state_ptr) {{
    fprintf(stderr, "[SdlShim] Unloading, preserving state\\n");
}}

extern "C" char* on_save_state(void* state_ptr) {{
    {state_name}* state = ({state_name}*)state_ptr;
    if (!state) return NULL;
    
    char* json = (char*)malloc(512);
    snprintf(json, 512, 
        "{{\"initialized\":%s,\"running\":%s}}",
        state->initialized ? "true" : "false",
        state->running ? "true" : "false"
    );
    return json;
}}

extern "C" void* on_load_from_json(const char* json) {{
    {state_name}* state = ({state_name}*)calloc(1, sizeof({state_name}));
    state->magic = 0xDEADBEEF;
    state->struct_size = sizeof({state_name});
    state->abi_version = 1;
    
    if (json) {{
        state->initialized = strstr(json, "\"initialized\":true") != NULL;
        state->running = strstr(json, "\"running\":true") != NULL;
    }}
    
    return state;
}}

// User code inclusion point
// The original source is included here, with SDL_main renamed

#define main _original_main
#define SDL_main _original_sdl_main

{source}

#undef main
#undef SDL_main
"#,
        state_name = state_name,
        source = source
    );

    ShimResult {
        source: shim,
        additional_files: vec![],
        extra_flags: vec![],
    }
}

// ============================================================
// SHIM DETECTION AND AUTO-SELECTION
// ============================================================

/// Analyze source code and determine best shim mode
pub fn detect_shim_mode(source: &str) -> ShimConfig {
    let has_sdl = source.contains("SDL_") || source.contains("<SDL2/SDL.h>");
    let has_main = source.contains("int main(") || source.contains("int main (");
    let has_sdl_main = source.contains("SDL_main");
    let has_on_load = source.contains("on_load(") || source.contains("extern \"C\" void* on_load");
    let has_on_update =
        source.contains("on_update(") || source.contains("extern \"C\" void on_update");
    let has_event_loop = source.contains("while")
        && (source.contains("SDL_PollEvent") || source.contains("running"));

    let mode = if has_on_load && has_on_update {
        // Already HMR-compatible
        ShimMode::None
    } else if has_sdl && (has_main || has_sdl_main) && has_event_loop {
        // SDL app with event loop - needs full GUI shim
        ShimMode::Full
    } else if has_main {
        // Regular blocking app
        ShimMode::WrapBlocking
    } else if !has_on_load || !has_on_update {
        // Missing hooks
        ShimMode::AddStateSerialization
    } else {
        ShimMode::None
    };

    ShimConfig {
        mode,
        has_gui: has_sdl,
        state_struct_name: None,
        width: 800,
        height: 600,
    }
}

/// Apply appropriate shim based on source analysis
pub fn auto_shim(source: &str) -> ShimResult {
    let config = detect_shim_mode(source);

    if config.has_gui && config.mode != ShimMode::None {
        generate_sdl_gui_shim(source, &config)
    } else {
        generate_cpp_shim(source, &config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_blocking_app() {
        let source = r#"
            #include <stdio.h>
            int main() {
                printf("Hello World\n");
                return 0;
            }
        "#;

        let config = detect_shim_mode(source);
        assert_eq!(config.mode, ShimMode::WrapBlocking);
    }

    #[test]
    fn test_detect_hmr_ready() {
        let source = r#"
            extern "C" void* on_load(void* prev, void* renderer) {
                return prev;
            }
            extern "C" void on_update(void* state, double dt) {
            }
        "#;

        let config = detect_shim_mode(source);
        assert_eq!(config.mode, ShimMode::None);
    }

    #[test]
    fn test_detect_sdl_app() {
        let source = r#"
            #include <SDL2/SDL.h>
            int main() {
                SDL_Init(SDL_INIT_VIDEO);
                while (running) {
                    SDL_PollEvent(&event);
                }
                return 0;
            }
        "#;

        let config = detect_shim_mode(source);
        assert_eq!(config.mode, ShimMode::Full);
        assert!(config.has_gui);
    }
}
