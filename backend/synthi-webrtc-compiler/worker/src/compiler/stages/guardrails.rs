use regex::Regex;

// ============================================================
// GUARDRAIL HELPER FUNCTIONS
// ============================================================
// These functions apply all guardrails to source content BEFORE
// hash computation, ensuring rebuild scope decisions are based
// on the actual compiled content.

/// Apply guardrails to shared.h content
pub fn apply_shared_guardrails(content: &str) -> String {
    let mut result = content.to_string();
    
    // Guardrails: AI sometimes typedefs X11 types to void, which conflicts with Xlib headers.
    for bad in ["typedef void Display", "typedef void GC", "typedef void Atom", "typedef void XIM", "typedef void XIC"] {
        if result.contains(bad) {
            result = result.replace(bad, "// stripped invalid typedef\n");
        }
    }

    // Strip conflicting forward declarations of X11 types and normalize struct field types.
    for bad in [
        "struct Display;", "struct Window;", "struct Atom;", "struct XIM;", "struct XIC;", "struct Pixmap;", "struct GC;", "struct XWindowAttributes;"
    ] {
        if result.contains(bad) {
            result = result.replace(bad, "// stripped conflicting X11 forward decl\n");
        }
    }
    result = result.replace("struct Display*", "Display*");
    result = result.replace("struct Window", "Window");
    result = result.replace("struct Atom", "Atom");
    result = result.replace("struct XIM*", "XIM*");
    result = result.replace("struct XIC*", "XIC*");
    result = result.replace("struct Pixmap", "Pixmap");
    result = result.replace("struct GC", "GC");
    result = result.replace("struct XWindowAttributes", "XWindowAttributes");

    // Guardrail: SDL_Event is a union in SDL2. Forward-declaring it as a struct
    // (e.g. `struct SDL_Event;`) causes compile failures when SDL.h is included.
    for bad in [
        "struct SDL_Event;",
        "typedef struct SDL_Event SDL_Event;",
        "typedef struct SDL_Event SDL_Event ;",
    ] {
        if result.contains(bad) {
            result = result.replace(bad, "/* stripped invalid SDL_Event forward decl */");
        }
    }

    // FIX: gui_on_load declaration MUST have 3 parameters to match implementation
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
       !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
        );
        eprintln!("[Guardrail] Fixed gui_on_load declaration in shared.h: added missing core_api_ptr parameter");
    }
    
    result
}

/// Apply guardrails to core.cpp content (requires processed shared.h for context)
pub fn apply_core_guardrails(content: &str, shared_content: &str, allow_gui: bool) -> String {
    let mut result = content.to_string();
    
    // Fix common AI mistakes in core.cpp before compilation.
    if result.contains("is_running") {
        result = result.replace("is_running", "running");
    }

    // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
    // Only applies if we are strictly enforcing core/gui split (allow_gui = false)
    if !allow_gui {
        let x11_type_patterns = [
            "Display*", "Display *", "Window*", "XIM", "XIC", "Atom", "Colormap", "Pixmap", "GC ",
            "XEvent", "XOpenDisplay", "XCloseDisplay", "XCreateWindow", "XDestroyWindow",
            "XOpenIM", "XCreateIC", "XCreateGC", "XFreeGC", "XCreatePixmap", "XFreePixmap",
        ];
        
        let mut cleaned_lines = Vec::new();
        for line in result.lines() {
            let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
            let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
            let is_include = line.trim_start().starts_with("#include");
            
            if has_x11 && !is_comment && !is_include {
                cleaned_lines.push(format!("// [X11-stripped] {}", line));
            } else {
                cleaned_lines.push(line.to_string());
            }
        }
        result = cleaned_lines.join("\n");
    }

    // CRITICAL: Ensure shared.h is included FIRST
    if !result.contains("#include \"shared.h\"") {
        if let Some(pos) = result.find("#include <") {
            if let Some(newline) = result[pos..].find('\n') {
                let insert_pos = pos + newline + 1;
                result.insert_str(insert_pos, "#include \"shared.h\"  // [Guardrail] Added\n");
            }
        } else {
            result = format!("#include \"shared.h\"  // [Guardrail] Added\n{}", result);
        }
    }

    // CRITICAL FIX: Transform malloc-based on_load to static storage
    if result.contains("malloc(sizeof(AppState))") && result.contains("on_load") {
        if !result.contains("static AppState app_state") && !result.contains("static CoreState core_state") {
            if let Some(on_load_pos) = result.find("extern \"C\" void* on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            } else if let Some(on_load_pos) = result.find("extern \"C\" void* core_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            }
        }
        
        let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_malloc2 = Regex::new(r"CoreState\*\s+state\s*=\s*\(CoreState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*CoreState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "CoreState* state = (prev_state) ? (CoreState*)prev_state : &core_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_if_malloc = Regex::new(r"if\s*\(\s*!prev_state\s*\)\s*\{\s*state\s*=\s*\(AppState\*\)\s*malloc[^}]+\}").unwrap();
        result = re_if_malloc.replace_all(&result, "if (!prev_state) { state = &app_state; /* [Guardrail] Fixed malloc->static */ }").to_string();
    }

    // FIX: Detect and warn about free(state) which causes crashes on reload
    if result.contains("free(state)") {
        result = result.replace("free(state);", "// free(state); // Commented - runner manages state");
    }

    // FIX: Detect and warn about memset on state which wipes preserved HMR state
    if result.contains("memset(state") || result.contains("memset(&app_state") || 
        result.contains("memset(&state") || result.contains("memset(&core_state") ||
        result.contains("memset( state") {
        let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&core_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
        result = re_memset.replace_all(&result, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
    }

    // Drop writes/reads to non-existent XWindowAttributes fields
    for bad_field in ["event_mask", "damage", "border_pixel", "background_pixel", "saved_attributes", "attributes_mask"] {
        if result.contains(bad_field) {
            let mut cleaned = String::new();
            for line in result.lines() {
                if line.contains(bad_field) {
                    cleaned.push_str("// stripped invalid field: ");
                    cleaned.push_str(line);
                    cleaned.push('\n');
                } else {
                    cleaned.push_str(line);
                    cleaned.push('\n');
                }
            }
            result = cleaned;
        }
    }

    // INJECT MISSING HEADERS
    if result.contains("setlocale") && !result.contains("#include <locale.h>") {
        result = format!("#include <locale.h>\n{}", result);
    }
    if result.contains("SDL_") && !result.contains("#include <SDL2/SDL.h>") {
        result = format!("#include <SDL2/SDL.h>\n{}", result);
    }
    if (result.contains("XLookupString") || result.contains("XK_Escape")) && !result.contains("#include <X11/Xutil.h>") {
        result = format!("#include <X11/Xutil.h>\n#include <X11/keysym.h>\n{}", result);
    }
    if (result.contains("dlopen") || result.contains("dlsym")) && !result.contains("#include <dlfcn.h>") {
        result = format!("#include <dlfcn.h>\n{}", result);
    }

    // FIX: Ensure shared.h is included in core.cpp if AppState is used
    if result.contains("AppState") && !result.contains("#include \"shared.h\"") {
        if result.contains("struct AppState;") {
            result = result.replace("struct AppState;", "#include \"shared.h\"");
        } else {
            result = format!("#include \"shared.h\"\n{}", result);
        }
    }

    // FIX: Remove duplicate defines that are already in shared.h
    if result.contains("#include \"shared.h\"") {
        result = result.replace("#define CORE_STATE_MAGIC", "// #define CORE_STATE_MAGIC");
        result = result.replace("#define SYNTHI_ABI_VERSION", "// #define SYNTHI_ABI_VERSION");
        
        // Strip duplicate AppState struct/typedef
        if let Some(start) = result.find("typedef struct AppState") {
            if let Some(end) = result[start..].find("} AppState;") {
                let block_end = start + end + "} AppState;".len();
                let block = result[start..block_end].to_string();
                result = result.replace(&block, "// AppState defined in shared.h");
            }
        }

        if let Some(start) = result.find("typedef struct {") {
            if let Some(end) = result[start..].find("} AppState;") {
                 let block_end = start + end + "} AppState;".len();
                 let block = result[start..block_end].to_string();
                 if block.contains("magic") && block.contains("struct_size") {
                     result = result.replace(&block, "// AppState defined in shared.h");
                 }
            }
        }
    }

    result
}

/// Patch string literals in cached JSON result with new strings from source
/// Returns (patched_result, did_patch_anything)
pub fn patch_strings_in_cached_result(
    cached: &serde_json::Value,
    old_strings: &[String],
    new_strings: &[String],
) -> (serde_json::Value, bool) {
    // Only patch if we have a reasonable mapping
    if old_strings.is_empty() || new_strings.is_empty() {
        return (cached.clone(), false);
    }

    let mut result = cached.clone();
    let mut any_patches_applied = false;

    // Patch each file's content in the split result
    for key in &["core", "gui", "shared"] {
        if let Some(file_obj) = result.get_mut(key) {
            if let Some(content) = file_obj.get_mut("content") {
                if let Some(content_str) = content.as_str() {
                    let mut patched = content_str.to_string();

                    // Replace old strings with new strings where they differ
                    // Match by position in the string list (assuming order is preserved)
                    for (old, new) in old_strings.iter().zip(new_strings.iter()) {
                        if old != new && !old.is_empty() {
                            // Use format with quotes to avoid partial matches
                            let old_quoted = format!("\"{}\"", old);
                            let new_quoted = format!("\"{}\"", new);
                            if patched.contains(&old_quoted) {
                                patched = patched.replace(&old_quoted, &new_quoted);
                                any_patches_applied = true;
                            }
                        }
                    }

                    *content = serde_json::Value::String(patched);
                }
            }
        }
    }

    (result, any_patches_applied)
}

/// Check if a string looks like a semantic value that AI transforms (not just copies)
/// These include: color names, font names, file paths, etc.
pub fn is_semantic_string(s: &str) -> bool {
    // X11/CSS color names
    let color_names = [
        "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta", "orange", "purple",
        "pink", "brown", "gray", "grey", "navy", "teal", "lime", "aqua", "maroon", "olive",
        "silver", "fuchsia",
    ];

    let lower = s.to_lowercase();
    color_names.iter().any(|c| lower == *c)
}

/// Get the Host KV header definitions
fn get_hostkv_header() -> &'static str {
    r#"
// ============================================================
// [Guardrail] HOST KV TYPE DEFINITIONS (auto-injected)
// ============================================================

#ifndef SYNTHI_HOST_KV_TYPES_DEFINED
#define SYNTHI_HOST_KV_TYPES_DEFINED

#include <stdint.h>

struct SynthiHostContextV1;
struct HostKvApiV1;

typedef struct SynthiNamespaceSchemaV1 {
    const char* ns;
    uint64_t schema_id;
} SynthiNamespaceSchemaV1;

typedef struct SynthiHostContextV1 {
    uint32_t host_api_version;
    const struct HostKvApiV1* kv;
    const char* session_id;
    uint32_t session_id_len;
    uint32_t module_slot;
    void* window;
    void* renderer;
    void* reserved[8];
} SynthiHostContextV1;

typedef struct HostKvApiV1 {
    uint32_t version;
    int (*set_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, const uint8_t* data, uint32_t len);
    int (*get_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, uint8_t** out, uint32_t* out_len);
    int (*delete_key)(const SynthiHostContextV1* ctx, const char* ns, const char* key);
    int (*clear_namespace)(const SynthiHostContextV1* ctx, const char* ns);
    int (*get_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t* out_schema);
    int (*set_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t schema);
    void* (*host_alloc)(uint32_t size);
    void (*host_free)(void* ptr);
    const char* (*last_error)(void);
} HostKvApiV1;

#endif // SYNTHI_HOST_KV_TYPES_DEFINED
"#
}

/// Apply guardrails to gui.cpp content (requires processed shared.h for context)
pub fn apply_gui_guardrails(content: &str, shared_content: &str) -> String {
    let mut result = content.to_string();
    
    // Detect if shared.h has full struct definitions
    let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {") ||
                                  shared_content.contains("struct SynthiHostContextV1 {") ||
                                  shared_content.contains("struct SynthiNamespaceSchemaV1 {");

    // Strip X11-related functions
    let x11_type_patterns = [
        "Display*", "Display *", "XIM", "XIC", "Atom", "Colormap", "Pixmap", "GC ",
        "XEvent", "XOpenDisplay", "XCloseDisplay", "XCreateWindow", "XDestroyWindow",
        "XOpenIM", "XCreateIC", "XCreateGC", "XFreeGC", "XCreatePixmap", "XFreePixmap",
    ];
    let mut cleaned_lines = Vec::new();
    for line in result.lines() {
        let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
        let is_comment = line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
        let is_include = line.trim_start().starts_with("#include");
        if has_x11 && !is_comment && !is_include {
            cleaned_lines.push(format!("// [X11-stripped] {}", line));
        } else {
            cleaned_lines.push(line.to_string());
        }
    }
    result = cleaned_lines.join("\n");

    // FIX: GUI module should use GUI_STATE_MAGIC
    if result.contains("CORE_STATE_MAGIC") && !result.contains("#define CORE_STATE_MAGIC") {
        result = result.replace("CORE_STATE_MAGIC", "GUI_STATE_MAGIC");
    }

    // FIX: Ensure shared.h is included
    if result.contains("AppState") && !result.contains("#include \"shared.h\"") {
        if result.contains("struct AppState;") {
            result = result.replace("struct AppState;", "#include \"shared.h\"");
        } else {
            result = format!("#include \"shared.h\"\n{}", result);
        }
    }
    
    // Strip duplicate AppState definitions
    if result.contains("#include \"shared.h\"") {
        if let Some(start) = result.find("typedef struct AppState") {
            if let Some(end) = result[start..].find("} AppState;") {
                let block_end = start + end + "} AppState;".len();
                let block = result[start..block_end].to_string();
                result = result.replace(&block, "// AppState defined in shared.h");
            }
        }

        if let Some(start) = result.find("typedef struct {") {
            if let Some(end) = result[start..].find("} AppState;") {
                 let block_end = start + end + "} AppState;".len();
                 let block = result[start..block_end].to_string();
                 if block.contains("magic") && block.contains("struct_size") {
                     result = result.replace(&block, "// AppState defined in shared.h");
                 }
            }
        }
        
        if let Some(start) = result.find("struct AppState {") {
            if let Some(end) = result[start..].find("};") {
                let block_end = start + end + "};".len();
                let block = result[start..block_end].to_string();
                if block.contains("{") {
                    result = result.replace(&block, "// AppState defined in shared.h");
                }
            }
        }

        // Handle Host KV structs
        for struct_name in &["HostKvApiV1", "SynthiHostContextV1", "SynthiNamespaceSchemaV1"] {
             let typedef_pattern = format!("typedef struct {} {};", struct_name, struct_name);
             if result.contains(&typedef_pattern) {
                 result = result.replace(&typedef_pattern, &format!("// {} forward-declared in shared.h", struct_name));
             }
             
             if shared_has_full_hostkv {
                 let struct_decl = format!("struct {} {{", struct_name);
                 if let Some(start) = result.find(&struct_decl) {
                     if let Some(end) = result[start..].find("};") {
                         let block_end = start + end + "};".len();
                         let block = result[start..block_end].to_string();
                         result = result.replace(&block, &format!("// {} fully defined in shared.h", struct_name));
                     }
                 }
             }
        }
        
        // Inject Host KV definitions if needed
        let uses_hostkv_types = result.contains("SynthiHostContextV1") || 
                                result.contains("SynthiNamespaceSchemaV1") ||
                                result.contains("HostKvApiV1") ||
                                result.contains("g_gui_schemas") ||
                                result.contains("host_kv_schemas");
        
        if uses_hostkv_types && !shared_has_full_hostkv {
            let hostkv_header = get_hostkv_header();
            if let Some(include_end) = result.rfind("#include") {
                if let Some(newline_pos) = result[include_end..].find('\n') {
                    let insert_pos = include_end + newline_pos + 1;
                    result.insert_str(insert_pos, &hostkv_header);
                }
            } else {
                result = format!("{}{}", hostkv_header, result);
            }
        }
    }

    // FIX: gui_on_load MUST have 3 parameters
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)") && 
       !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)") {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)"
        );
    }

    // FIX: Comment out SDL_RenderPresent
    let re_present = Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
    result = re_present.replace_all(&result, "/* SDL_RenderPresent removed - runner handles this */").to_string();

    // FIX: Replace SDL_GetKeyboardWindow
    if result.contains("SDL_GetKeyboardWindow") {
        result = result.replace("SDL_GetKeyboardWindow", "SDL_GetKeyboardFocus");
    }

    // Convert malloc-based gui_on_load to static storage
    if result.contains("malloc(sizeof(AppState))") && result.contains("gui_on_load") {
        if !result.contains("static AppState gui_app_state") && !result.contains("static GuiState gui_state") {
            if let Some(on_load_pos) = result.find("extern \"C\" void* gui_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState gui_app_state = {0};\n\n");
            }
        }
        
        let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed malloc->static").to_string();
        
        let re_malloc2 = Regex::new(r"GuiState\*\s+state\s*=\s*\(GuiState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*GuiState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "GuiState* state = (prev_state) ? (GuiState*)prev_state : &gui_state; // [Guardrail] Fixed malloc->static").to_string();
    }

    // FIX: free(state) crashes
    if result.contains("free(state)") {
        result = result.replace("free(state);", "// free(state); // Commented - runner manages state");
    }

    // FIX: memset wipes HMR state
    if result.contains("memset(state") || result.contains("memset(&app_state") || 
        result.contains("memset(&gui_state") || result.contains("memset(&state") ||
        result.contains("memset(&gui_app_state") || result.contains("memset( state") {
        let re_memset = Regex::new(r"memset\s*\(\s*(state|&app_state|&gui_state|&state|&gui_app_state)[^;]*\)\s*;").unwrap();
        result = re_memset.replace_all(&result, "// [Guardrail] memset REMOVED to preserve HMR state").to_string();
    }

    // FIX: app_state -> gui_app_state in gui.cpp
    if result.contains("static AppState gui_app_state") || result.contains("&gui_app_state") {
        if result.contains("&app_state") && !result.contains("&gui_app_state") {
            result = result.replace("&app_state", "&gui_app_state");
        }
        
        if result.contains("gui_app_state") {
            let placeholder = "__GUI_APP_STATE_PLACEHOLDER__";
            let temp_content = result.replace("gui_app_state", placeholder);
            if temp_content.contains("app_state") {
                let fixed_content = temp_content.replace("app_state", "gui_app_state");
                result = fixed_content.replace(placeholder, "gui_app_state");
            }
        }
    }

    // Add entrypoint if needed
    if result.contains("main(") && !result.contains("extern \"C\" void* entrypoint") {
         result.push_str("\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n");
    }

    // FIX: renderer -> state->renderer
    if result.contains("SDL_Render") || result.contains("SDL_SetRenderDrawColor") || result.contains("draw_text") {
        let fixes = [
            ("SDL_RenderFillRect(renderer,", "SDL_RenderFillRect(state->renderer,"),
            ("SDL_RenderDrawRect(renderer,", "SDL_RenderDrawRect(state->renderer,"),
            ("SDL_SetRenderDrawColor(renderer,", "SDL_SetRenderDrawColor(state->renderer,"),
            ("SDL_RenderClear(renderer)", "SDL_RenderClear(state->renderer)"),
            ("draw_text(renderer,", "draw_text(state->renderer,"),
        ];
        for (wrong, correct) in &fixes {
            if result.contains(*wrong) {
                result = result.replace(*wrong, *correct);
            }
        }
    }

    // FIX: x/y -> mx/my in click handlers
    if result.contains("SDL_MOUSEBUTTONDOWN") {
        let click_fixes = [
            ("if (x >= state->", "if (mx >= state->"),
            ("if (y >= state->", "if (my >= state->"),
            ("&& x <", "&& mx <"),
            ("&& y <", "&& my <"),
            ("&& x <=", "&& mx <="),
            ("&& y <=", "&& my <="),
        ];
        for (wrong, correct) in &click_fixes {
            if result.contains(*wrong) {
                result = result.replace(*wrong, *correct);
            }
        }
    }
    
    // Inject GUI state serialization stubs
    if result.contains("gui_on_load") && 
       !result.contains("gui_on_save_state") &&
       !result.contains("gui_get_state_schema_hash") {
        let gui_serial_stubs = r#"

// [Guardrail] State serialization stubs for Full HMR capability (GUI)
extern "C" char* gui_on_save_state(void* state_ptr) {
    (void)state_ptr;
    char* json = (char*)malloc(3);
    if (json) strcpy(json, "{}");
    return json;
}

extern "C" void* gui_on_load_from_json(const char* json) {
    (void)json;
    return NULL;
}

extern "C" void synthi_free_json(char* json) {
    if (json) free(json);
}
"#;
        result.push_str(gui_serial_stubs);
    }
    
    result
}
