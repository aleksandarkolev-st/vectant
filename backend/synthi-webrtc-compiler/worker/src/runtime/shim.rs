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
#include <pthread.h>
#include <stdint.h>

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
    pthread_t user_thread;   // Thread for running blocking user code
}} {state_name};

// Forward declare user's original main
__attribute__((visibility("default"))) int _user_main(int argc, char* argv[]);

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
#include <pthread.h>

// Rename user's main to _user_main
#define main _user_main

// --- USER CODE STARTS ---
{user_source}
// --- USER CODE ENDS ---

#undef main

// ============================================================
// HMR HOOKS
// ============================================================

// Wrapper to run user main in a thread
static void* _user_main_thread_entry(void* arg) {{
    (void)arg;
    char* argv[] = {{(char*)"app", NULL}};
    _user_main(1, argv);
    return NULL;
}}

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
    
    // Run user's main() exactly once, in a separate thread, on first frame
    if (!state->initialized && state->first_frame) {{
        fprintf(stderr, "[Shim] Spawning user main() thread (non-blocking)\\n");
        state->first_frame = false;
        state->initialized = true;
        
        // Create thread for user main
        pthread_create(&state->user_thread, NULL, _user_main_thread_entry, NULL);
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
// NEW HOTAPI V2 SHIM GENERATOR
// ============================================================
// Generates a single export (hot_get_api) + static HotApi table
// that wraps internal Rust/C app functions to the new ABI.
// ============================================================

/// Configuration for HotApi v2 shim generation
#[derive(Debug, Clone)]
pub struct HotApiShimConfig {
    /// State struct name
    pub state_name: String,
    /// State struct size in bytes
    pub state_size: usize,
    /// State alignment (must be power of 2)
    pub state_align: usize,
    /// State version (module-defined)
    pub state_version: u32,
    /// ABI fingerprint (hash of state layout)
    pub abi_fingerprint: u64,
    /// Fields for MsgPack serialization
    pub fields: Vec<HotApiField>,
}

/// Field descriptor for serialization
#[derive(Debug, Clone)]
pub struct HotApiField {
    pub name: String,
    pub c_type: String,
    pub offset: usize,
    pub size: usize,
    /// Default value as string (e.g., "0", "1.0")
    pub default_value: Option<String>,
}

impl Default for HotApiShimConfig {
    fn default() -> Self {
        Self {
            state_name: "AppState".to_string(),
            state_size: 64,
            state_align: 8,
            state_version: 1,
            abi_fingerprint: 0,
            fields: Vec::new(),
        }
    }
}

/// Generate HotApi v2 shim for C/C++ code
///
/// This generates:
/// - A static HotApi table with all function pointers
/// - The single export: hot_get_api()
/// - Wrapper functions for init, tick, render, event
/// - MsgPack serialization using size-then-write pattern
pub fn generate_hot_api_shim(source: &str, config: &HotApiShimConfig) -> ShimResult {
    let state_name = &config.state_name;
    let field_count = config.fields.len();

    // Calculate ABI fingerprint if not provided
    let abi_fingerprint = if config.abi_fingerprint == 0 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        use std::hash::{Hash, Hasher};
        config.state_name.hash(&mut hasher);
        config.state_size.hash(&mut hasher);
        for f in &config.fields {
            f.name.hash(&mut hasher);
            f.c_type.hash(&mut hasher);
            f.offset.hash(&mut hasher);
        }
        hasher.finish()
    } else {
        config.abi_fingerprint
    };

    // Generate field serialization code for MsgPack
    let mut msgpack_size_code = String::new();
    let mut msgpack_write_code = String::new();
    let mut migrate_code = String::new();

    for field in &config.fields {
        // Size calculation (MsgPack encoding overhead)
        let type_overhead = match field.c_type.as_str() {
            "int" | "int32_t" => 5, // fixint or int32
            "uint32_t" | "unsigned" => 5,
            "int64_t" | "long" => 9,
            "uint64_t" => 9,
            "float" => 5,
            "double" => 9,
            "bool" | "char" => 2,
            _ => 5,
        };
        let str_overhead = field.name.len() + 3; // fixstr header + name

        msgpack_size_code.push_str(&format!(
            "    size += {}; // {} (key)\n    size += {}; // {} (value)\n",
            str_overhead, field.name, type_overhead, field.c_type
        ));

        // Write code
        msgpack_write_code.push_str(&format!(
            "    // Write field: {}\n    write_fixstr(out, out_cap, pos, \"{}\", {});\n",
            field.name,
            field.name,
            field.name.len()
        ));

        match field.c_type.as_str() {
            "int" | "int32_t" => {
                msgpack_write_code.push_str(&format!(
                    "    write_int32(out, out_cap, pos, state->{});\n",
                    field.name
                ));
            }
            "float" => {
                msgpack_write_code.push_str(&format!(
                    "    write_float32(out, out_cap, pos, state->{});\n",
                    field.name
                ));
            }
            _ => {
                msgpack_write_code.push_str(&format!(
                    "    write_int32(out, out_cap, pos, (int32_t)state->{});\n",
                    field.name
                ));
            }
        }

        // Migration code - decode from MsgPack
        let default_val = field.default_value.as_deref().unwrap_or("0");
        migrate_code.push_str(&format!(
            "    new_state->{} = decode_field_or_default(old_msgpack, old_msgpack_len, \"{}\", {});\n",
            field.name, field.name, default_val
        ));
    }

    let shim = format!(
        r#"
// ============================================================
// SYNTHI HOTAPI V2 SHIM - Auto-generated
// Single export ABI with MsgPack serialization
// ============================================================

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {{
#endif

// ============================================================
// RUNNER API (provided by host)
// ============================================================

typedef struct RunnerApi {{
    uint32_t struct_size;
    uint32_t api_version;
    void (*log)(uint32_t level, const uint8_t* msg, size_t len);
    uint64_t (*get_time_ns)(void);
    size_t _reserved[8];
}} RunnerApi;

// ============================================================
// EVENT (POD, no SDL types)
// ============================================================

typedef struct Event {{
    uint32_t kind;
    uint32_t a;
    uint32_t b;
    uint32_t c;
    const void* payload_ptr;
    size_t payload_len;
}} Event;

// ============================================================
// STATE STRUCT
// ============================================================

// User's state struct should be defined before this shim is included
// typedef struct {state_name} {{ ... }} {state_name};

// ============================================================
// FUNCTION POINTER TYPES
// ============================================================

typedef bool (*InitFn)(void* state, const RunnerApi* host);
typedef void (*ShutdownFn)(void* state, const RunnerApi* host);
typedef void (*TickFn)(void* state, const RunnerApi* host, float dt);
typedef void (*RenderFn)(void* state, const RunnerApi* host);
typedef void (*EventFn)(void* state, const Event* e, const RunnerApi* host);
typedef size_t (*SaveSizeFn)(const void* state, uint32_t state_version, const RunnerApi* host);
typedef bool (*SaveWriteFn)(const void* state, uint32_t state_version, const RunnerApi* host, uint8_t* out, size_t out_cap, size_t* out_written);
typedef bool (*MigrateFn)(const void* old_blob, uint32_t old_ver, void* new_blob, uint32_t new_ver, const RunnerApi* host, const uint8_t* old_msgpack, size_t old_msgpack_len, const uint8_t* old_json, size_t old_json_len);

// ============================================================
// HOTAPI TABLE
// ============================================================

typedef struct HotApi {{
    uint32_t struct_size;
    uint32_t api_version;
    uint32_t state_version;
    uint64_t abi_fingerprint;
    size_t state_size_bytes;
    size_t state_align_bytes;
    size_t state_min_size_bytes;
    InitFn init;
    ShutdownFn shutdown;
    TickFn tick;
    RenderFn render;
    EventFn event;
    MigrateFn migrate;
    SaveSizeFn save_state_msgpack_size;
    SaveWriteFn save_state_msgpack_write;
    SaveSizeFn save_state_json_size;
    SaveWriteFn save_state_json_write;
}} HotApi;

// ============================================================
// MSGPACK HELPERS (allocation-free)
// ============================================================

static inline void write_fixstr(uint8_t* out, size_t cap, size_t* pos, const char* str, size_t len) {{
    if (*pos + 1 + len > cap) return;
    out[(*pos)++] = 0xa0 | (len & 0x1f);
    memcpy(out + *pos, str, len);
    *pos += len;
}}

static inline void write_int32(uint8_t* out, size_t cap, size_t* pos, int32_t val) {{
    if (val >= 0 && val <= 127) {{
        if (*pos + 1 > cap) return;
        out[(*pos)++] = (uint8_t)val;
    }} else if (val >= -32 && val < 0) {{
        if (*pos + 1 > cap) return;
        out[(*pos)++] = (uint8_t)val;
    }} else {{
        if (*pos + 5 > cap) return;
        out[(*pos)++] = 0xd2;
        out[(*pos)++] = (val >> 24) & 0xff;
        out[(*pos)++] = (val >> 16) & 0xff;
        out[(*pos)++] = (val >> 8) & 0xff;
        out[(*pos)++] = val & 0xff;
    }}
}}

static inline void write_float32(uint8_t* out, size_t cap, size_t* pos, float val) {{
    if (*pos + 5 > cap) return;
    out[(*pos)++] = 0xca;
    union {{ float f; uint32_t u; }} conv = {{ .f = val }};
    out[(*pos)++] = (conv.u >> 24) & 0xff;
    out[(*pos)++] = (conv.u >> 16) & 0xff;
    out[(*pos)++] = (conv.u >> 8) & 0xff;
    out[(*pos)++] = conv.u & 0xff;
}}

static inline void write_map_header(uint8_t* out, size_t cap, size_t* pos, size_t count) {{
    if (count <= 15) {{
        if (*pos + 1 > cap) return;
        out[(*pos)++] = 0x80 | (count & 0x0f);
    }} else {{
        if (*pos + 3 > cap) return;
        out[(*pos)++] = 0xde;
        out[(*pos)++] = (count >> 8) & 0xff;
        out[(*pos)++] = count & 0xff;
    }}
}}

// MsgPack field decoder - parses fixmap/map16 to find field by name
static inline int32_t decode_field_or_default(const uint8_t* data, size_t len, const char* name, int32_t def) {{
    if (!data || len == 0 || !name) return def;
    
    size_t pos = 0;
    size_t name_len = 0;
    while (name[name_len]) name_len++;
    
    // Parse map header
    uint32_t map_count = 0;
    if (pos >= len) return def;
    
    uint8_t header = data[pos++];
    if ((header & 0xf0) == 0x80) {{
        // fixmap: 1000xxxx where xxxx is count (0-15)
        map_count = header & 0x0f;
    }} else if (header == 0xde) {{
        // map16: 0xde followed by 2 bytes count
        if (pos + 2 > len) return def;
        map_count = ((uint32_t)data[pos] << 8) | data[pos + 1];
        pos += 2;
    }} else if (header == 0xdf) {{
        // map32: 0xdf followed by 4 bytes count
        if (pos + 4 > len) return def;
        map_count = ((uint32_t)data[pos] << 24) | ((uint32_t)data[pos+1] << 16) |
                    ((uint32_t)data[pos+2] << 8) | data[pos+3];
        pos += 4;
    }} else {{
        return def;  // Not a map
    }}
    
    // Iterate through map entries
    for (uint32_t i = 0; i < map_count && pos < len; i++) {{
        // Parse key (expecting string)
        size_t key_len = 0;
        const uint8_t* key_data = NULL;
        
        uint8_t key_header = data[pos++];
        if ((key_header & 0xe0) == 0xa0) {{
            // fixstr: 101xxxxx where xxxxx is length (0-31)
            key_len = key_header & 0x1f;
        }} else if (key_header == 0xd9) {{
            // str8
            if (pos >= len) return def;
            key_len = data[pos++];
        }} else if (key_header == 0xda) {{
            // str16
            if (pos + 2 > len) return def;
            key_len = ((size_t)data[pos] << 8) | data[pos + 1];
            pos += 2;
        }} else {{
            // Skip this entry - key is not a string
            continue;
        }}
        
        if (pos + key_len > len) return def;
        key_data = &data[pos];
        pos += key_len;
        
        // Check if this is our field
        int match = (key_len == name_len);
        if (match) {{
            for (size_t j = 0; j < name_len; j++) {{
                if (key_data[j] != (uint8_t)name[j]) {{
                    match = 0;
                    break;
                }}
            }}
        }}
        
        // Parse value
        if (pos >= len) return def;
        uint8_t val_header = data[pos++];
        
        if (match) {{
            // Decode value as int32
            if (val_header <= 0x7f) {{
                // positive fixint
                return (int32_t)val_header;
            }} else if (val_header >= 0xe0) {{
                // negative fixint
                return (int32_t)(int8_t)val_header;
            }} else if (val_header == 0xd0) {{
                // int8
                if (pos >= len) return def;
                return (int32_t)(int8_t)data[pos];
            }} else if (val_header == 0xd1) {{
                // int16
                if (pos + 2 > len) return def;
                int16_t v = (int16_t)(((uint16_t)data[pos] << 8) | data[pos + 1]);
                return (int32_t)v;
            }} else if (val_header == 0xd2) {{
                // int32
                if (pos + 4 > len) return def;
                return (int32_t)(((uint32_t)data[pos] << 24) | ((uint32_t)data[pos+1] << 16) |
                                 ((uint32_t)data[pos+2] << 8) | data[pos+3]);
            }} else if (val_header == 0xcc) {{
                // uint8
                if (pos >= len) return def;
                return (int32_t)data[pos];
            }} else if (val_header == 0xcd) {{
                // uint16
                if (pos + 2 > len) return def;
                return (int32_t)(((uint16_t)data[pos] << 8) | data[pos + 1]);
            }} else if (val_header == 0xce) {{
                // uint32 - truncate to int32
                if (pos + 4 > len) return def;
                uint32_t v = ((uint32_t)data[pos] << 24) | ((uint32_t)data[pos+1] << 16) |
                             ((uint32_t)data[pos+2] << 8) | data[pos+3];
                return (int32_t)v;
            }}
            return def;  // Unsupported type
        }}
        
        // Skip value if not matching
        // We need to skip based on type
        if (val_header <= 0x7f || val_header >= 0xe0) {{
            // fixint - already consumed
        }} else if ((val_header & 0xe0) == 0xa0) {{
            // fixstr
            pos += (val_header & 0x1f);
        }} else if ((val_header & 0xf0) == 0x90) {{
            // fixarray - skip elements (simplified: assumes flat values)
            pos += (val_header & 0x0f);
        }} else if ((val_header & 0xf0) == 0x80) {{
            // fixmap - skip entries (simplified)
            pos += (val_header & 0x0f) * 2;
        }} else if (val_header == 0xc0 || val_header == 0xc2 || val_header == 0xc3) {{
            // nil, false, true - no additional bytes
        }} else if (val_header == 0xcc || val_header == 0xd0) {{
            pos += 1;  // uint8/int8
        }} else if (val_header == 0xcd || val_header == 0xd1) {{
            pos += 2;  // uint16/int16
        }} else if (val_header == 0xce || val_header == 0xd2 || val_header == 0xca) {{
            pos += 4;  // uint32/int32/float32
        }} else if (val_header == 0xcf || val_header == 0xd3 || val_header == 0xcb) {{
            pos += 8;  // uint64/int64/float64
        }} else if (val_header == 0xd9) {{
            if (pos >= len) return def;
            pos += 1 + data[pos];  // str8
        }} else if (val_header == 0xda) {{
            if (pos + 2 > len) return def;
            size_t slen = ((size_t)data[pos] << 8) | data[pos + 1];
            pos += 2 + slen;  // str16
        }} else {{
            // Unknown type - can't safely skip
            return def;
        }}
    }}
    
    return def;  // Field not found
}}

// ============================================================
// WRAPPER FUNCTIONS
// ============================================================

static bool hot_init(void* state, const RunnerApi* host) {{
    {state_name}* s = ({state_name}*)state;
    memset(s, 0, sizeof({state_name}));
    // User init code can go here
    return true;
}}

static void hot_shutdown(void* state, const RunnerApi* host) {{
    {state_name}* s = ({state_name}*)state;
    // User cleanup code can go here
    (void)s; (void)host;
}}

static void hot_tick(void* state, const RunnerApi* host, float dt) {{
    {state_name}* s = ({state_name}*)state;
    // Call user's on_update if it exists
    #ifdef USER_ON_UPDATE
    on_update(s, (double)dt);
    #endif
    (void)host;
}}

static void hot_render(void* state, const RunnerApi* host) {{
    {state_name}* s = ({state_name}*)state;
    // Call user's render if it exists
    #ifdef USER_ON_RENDER
    on_render(s);
    #endif
    (void)host;
}}

static void hot_event(void* state, const Event* e, const RunnerApi* host) {{
    {state_name}* s = ({state_name}*)state;
    // Call user's event handler if it exists
    #ifdef USER_ON_EVENT
    on_event(s, e);
    #endif
    (void)host;
}}

// ============================================================
// MSGPACK SERIALIZATION (size-then-write)
// ============================================================

static size_t hot_save_msgpack_size(const void* state, uint32_t state_version, const RunnerApi* host) {{
    (void)state; (void)state_version; (void)host;
    size_t size = 1; // Map header
{msgpack_size_code}
    return size;
}}

static bool hot_save_msgpack_write(const void* state_ptr, uint32_t state_version, const RunnerApi* host, uint8_t* out, size_t out_cap, size_t* out_written) {{
    (void)state_version; (void)host;
    const {state_name}* state = (const {state_name}*)state_ptr;
    size_t pos = 0;
    
    // Write map header
    write_map_header(out, out_cap, &pos, {field_count});
    
    // Write fields
{msgpack_write_code}
    
    *out_written = pos;
    return true;
}}

// ============================================================
// MIGRATION (uses MsgPack, NOT old struct pointer)
// ============================================================

static bool hot_migrate(const void* old_blob, uint32_t old_ver, void* new_blob, uint32_t new_ver, const RunnerApi* host, const uint8_t* old_msgpack, size_t old_msgpack_len, const uint8_t* old_json, size_t old_json_len) {{
    (void)old_blob; (void)old_ver; (void)new_ver; (void)host; (void)old_json; (void)old_json_len;
    
    if (!old_msgpack || old_msgpack_len == 0) {{
        return false; // No serialized data to migrate from
    }}
    
    {state_name}* new_state = ({state_name}*)new_blob;
    memset(new_state, 0, sizeof({state_name}));
    
    // Decode fields from MsgPack (uses keyed lookup, not position)
{migrate_code}
    
    return true;
}}

// ============================================================
// STATIC HOTAPI TABLE
// ============================================================

static const HotApi HOT_API = {{
    .struct_size = sizeof(HotApi),
    .api_version = 2,
    .state_version = {state_version},
    .abi_fingerprint = 0x{abi_fingerprint:016X}ULL,
    .state_size_bytes = sizeof({state_name}),
    .state_align_bytes = {state_align},
    .state_min_size_bytes = 0,
    .init = hot_init,
    .shutdown = hot_shutdown,
    .tick = hot_tick,
    .render = hot_render,
    .event = hot_event,
    .migrate = hot_migrate,
    .save_state_msgpack_size = hot_save_msgpack_size,
    .save_state_msgpack_write = hot_save_msgpack_write,
    .save_state_json_size = NULL,
    .save_state_json_write = NULL,
}};

// ============================================================
// SINGLE EXPORT
// ============================================================

__attribute__((visibility("default")))
const HotApi* hot_get_api(void) {{
    return &HOT_API;
}}

#ifdef __cplusplus
}}
#endif

// ============================================================
// USER CODE FOLLOWS
// ============================================================

{source}
"#,
        state_name = state_name,
        state_version = config.state_version,
        abi_fingerprint = abi_fingerprint,
        state_align = config.state_align,
        field_count = field_count,
        msgpack_size_code = msgpack_size_code,
        msgpack_write_code = msgpack_write_code,
        migrate_code = migrate_code,
        source = source,
    );

    ShimResult {
        source: shim,
        additional_files: vec![],
        extra_flags: vec![
            "-fvisibility=hidden".to_string(), // Hide all symbols except hot_get_api
        ],
    }
}

// ============================================================
// SHIM DETECTION AND AUTO-SELECTION
// ============================================================

/// Analyze source code and determine best shim mode
pub fn detect_shim_mode(source: &str) -> ShimConfig {
    let has_sdl = source.contains("SDL_") || source.contains("<SDL2/SDL.h>");
    let has_x11 = source.contains("XOpenDisplay") || source.contains("<X11/");

    let has_main = source.contains("int main(") || source.contains("int main (");
    let has_sdl_main = source.contains("SDL_main");
    let has_on_load = source.contains("on_load(") || source.contains("extern \"C\" void* on_load");
    let has_on_update =
        source.contains("on_update(") || source.contains("extern \"C\" void on_update");
    let has_event_loop = source.contains("while")
        && (source.contains("SDL_PollEvent")
            || source.contains("running")
            || source.contains("XNextEvent")
            || source.contains("XPending"));

    // We only use Full shim (SDL replacement) for SDL apps.
    // X11 apps fall through to WrapBlocking but with has_gui=true.
    let mode = if has_on_load && has_on_update {
        // Already HMR-compatible
        ShimMode::None
    } else if has_sdl && (has_main || has_sdl_main) && has_event_loop {
        // SDL app with event loop - needs full GUI shim
        ShimMode::Full
    } else if has_main {
        // Regular blocking app (includes X11)
        ShimMode::WrapBlocking
    } else if !has_on_load || !has_on_update {
        // Missing hooks
        ShimMode::AddStateSerialization
    } else {
        ShimMode::None
    };

    ShimConfig {
        mode,
        has_gui: has_sdl || has_x11,
        state_struct_name: None,
        width: 800,
        height: 600,
    }
}

/// Apply appropriate shim based on source analysis
pub fn auto_shim(source: &str) -> ShimResult {
    let config = detect_shim_mode(source);

    // Only use the special SDL GUI shim if we are in Full mode (SDL app replacement).
    // For WrapBlocking (which includes X11 GUI apps), we want the standard threaded C++ shim
    // so that the main loop runs in a thread and doesn't block the runner.
    if config.mode == ShimMode::Full {
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
