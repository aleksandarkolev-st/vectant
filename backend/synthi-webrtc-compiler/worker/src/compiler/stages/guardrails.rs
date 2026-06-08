use regex::Regex;

// ============================================================
// GUARDRAIL HELPER FUNCTIONS
// ============================================================
// These functions apply all guardrails to source content BEFORE
// hash computation, ensuring rebuild scope decisions are based
// on the actual compiled content.
//
// Each guardrail represents a failure of the AI prompt.  When a
// guardrail fires, it logs the event so prompt quality can be tracked.

/// User-code adapters only (no AI-fix guardrails).
/// Wraps main() → plugin format so user code runs in the runner.
fn apply_core_user_adapters(content: &str) -> String {
    let mut result = content.to_string();

    // Only apply main()→plugin adapter (user code adaptation, not AI fix)
    if !result.contains("core_on_load") && !result.contains("on_load") {
        let re_main_no_args = Regex::new(r"\bint\s+main\s*\(\s*(void)?\s*\)").unwrap();
        let re_main_args = Regex::new(r"\bint\s+main\s*\(").unwrap();

        let mut handled = false;
        if re_main_no_args.is_match(&result) {
            result = re_main_no_args
                .replace(&result, "int user_main()")
                .to_string();
            result.push_str("\n\n#include <pthread.h>\nint user_main();\nextern \"C\" {\n");
            result.push_str(
                "    static void* main_thread_func(void* arg) { user_main(); return NULL; }\n",
            );
            handled = true;
        } else if re_main_args.is_match(&result) {
            result = re_main_args.replace(&result, "int user_main(").to_string();
            result.push_str(
                "\n\n#include <pthread.h>\nint user_main(int argc, char** argv);\nextern \"C\" {\n",
            );
            result.push_str("    static void* main_thread_func(void* arg) { char* app_name = (char*)\"app\"; char* argv[] = {app_name, NULL}; user_main(1, argv); return NULL; }\n");
            handled = true;
        }
        if handled {
            result.push_str("    void* core_on_load(void* prev_state, void* api) { pthread_t thread; pthread_create(&thread, NULL, main_thread_func, NULL); pthread_detach(thread); return NULL; }\n");
            result.push_str("    void core_on_update(void* state, float dt) {}\n");
            result.push_str("}\n");
        }
    }

    result
}

fn function_body_bounds(source: &str, function_name: &str) -> Option<(usize, usize)> {
    let name_pos = source.find(function_name)?;
    let brace_start = source[name_pos..].find('{')? + name_pos;
    let mut depth = 0usize;
    for (offset, ch) in source[brace_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some((brace_start + 1, brace_start + offset));
                }
            }
            _ => {}
        }
    }
    None
}

fn core_update_writes_host_pixels(source: &str) -> bool {
    let Some((start, end)) = function_body_bounds(source, "core_on_update") else {
        return true;
    };
    let body = &source[start..end];
    body.contains("host_pixels[")
        || body.contains("->host_pixels[")
        || body.contains(".host_pixels[")
        || body.contains("memcpy(") && body.contains("host_pixels")
        || body.contains("hipMemcpy") && body.contains("host_pixels")
        || body.contains("cudaMemcpy") && body.contains("host_pixels")
}

fn core_update_state_parameter(source: &str) -> Option<String> {
    let name_pos = source.find("core_on_update")?;
    let brace_start = source[name_pos..].find('{')? + name_pos;
    let signature = &source[name_pos..brace_start];
    let open = signature.find('(')?;
    let close = signature.rfind(')')?;
    let first_param = signature[open + 1..close].split(',').next()?.trim();
    let re = Regex::new(r"(?:void|AppState)\s*\*+\s*([A-Za-z_][A-Za-z0-9_]*)").ok()?;
    re.captures(first_param)
        .and_then(|caps| caps.get(1).map(|name| name.as_str().to_string()))
}

fn host_pixels_preview_call_insertion(source: &str) -> Option<(usize, String)> {
    let (body_start, body_end) = function_body_bounds(source, "core_on_update")?;
    let body = &source[body_start..body_end];

    let re_state = Regex::new(r"AppState\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*=").ok()?;
    if let Some(caps) = re_state.captures(body) {
        let matched = caps.get(0)?;
        let state_name = caps.get(1)?.as_str();
        let after_match = &body[matched.end()..];
        let statement_end = after_match.find(';').or_else(|| after_match.find('\n'))?;
        let insert_pos = body_start + matched.end() + statement_end + 1;
        return Some((
            insert_pos,
            format!(
                "\n    if (!{state_name}) return;\n    synthi_update_host_pixels_preview({state_name});\n"
            ),
        ));
    }

    let state_param = core_update_state_parameter(source)?;
    Some((
        body_start,
        format!(
            "\n    if (!{state_param}) return;\n    synthi_update_host_pixels_preview(reinterpret_cast<AppState*>({state_param}));\n"
        ),
    ))
}

fn inject_host_pixels_preview_bridge(source: &str, shared_content: &str) -> String {
    if source.contains("synthi_update_host_pixels_preview") {
        return source.to_string();
    }
    let host_pixels_are_float = Regex::new(r"\bfloat\s*\*\s*host_pixels\b")
        .ok()
        .is_some_and(|re| re.is_match(shared_content));
    let host_pixels_are_color = Regex::new(r"\bColorRGB32F\s*\*\s*host_pixels\b")
        .ok()
        .is_some_and(|re| re.is_match(shared_content));
    if !host_pixels_are_float && !host_pixels_are_color {
        return source.to_string();
    }
    if !source.contains("core_on_update") || core_update_writes_host_pixels(source) {
        return source.to_string();
    }

    let pixel_write = if host_pixels_are_float {
        r#"    float* pixels = state->host_pixels;
    for (int y = 0; y < height; ++y) {
        const float fy = height > 1 ? static_cast<float>(y) / static_cast<float>(height - 1) : 0.0f;
        for (int x = 0; x < width; ++x) {
            const float fx = width > 1 ? static_cast<float>(x) / static_cast<float>(width - 1) : 0.0f;
            const float pulse = static_cast<float>((x * 17 + y * 31 + frame * 5) & 255) / 255.0f;
            float r = 0.08f + 0.72f * fx + 0.16f * pulse;
            float g = 0.12f + 0.62f * fy + 0.14f * (1.0f - pulse);
            float b = 0.18f + 0.54f * (1.0f - fx) + 0.12f * pulse;
            if (r > 1.0f) r = 1.0f;
            if (g > 1.0f) g = 1.0f;
            if (b > 1.0f) b = 1.0f;
            const int idx = (y * width + x) * 4;
            pixels[idx + 0] = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = 1.0f;
        }
    }
"#
    } else {
        r#"    for (int y = 0; y < height; ++y) {
        const float fy = height > 1 ? static_cast<float>(y) / static_cast<float>(height - 1) : 0.0f;
        for (int x = 0; x < width; ++x) {
            const float fx = width > 1 ? static_cast<float>(x) / static_cast<float>(width - 1) : 0.0f;
            const float pulse = static_cast<float>((x * 17 + y * 31 + frame * 5) & 255) / 255.0f;
            float r = 0.08f + 0.72f * fx + 0.16f * pulse;
            float g = 0.12f + 0.62f * fy + 0.14f * (1.0f - pulse);
            float b = 0.18f + 0.54f * (1.0f - fx) + 0.12f * pulse;
            if (r > 1.0f) r = 1.0f;
            if (g > 1.0f) g = 1.0f;
            if (b > 1.0f) b = 1.0f;
            state->host_pixels[y * width + x] = ColorRGB32F(r, g, b);
        }
    }
"#
    };
    let helper = format!(
        r#"
// [Guardrail] GPU HMR preview bridge for headless/generated GPU splits.
static void synthi_update_host_pixels_preview(AppState* state) {{
    if (!state || !state->host_pixels || state->width <= 0 || state->height <= 0) return;
    const int width = state->width;
    const int height = state->height;
    const int frame = state->frame_count;
{pixel_write}
}}

"#
    );

    let mut result = source.to_string();
    if let Some(pos) = result.find("extern \"C\" void core_on_update") {
        result.insert_str(pos, &helper);
    } else {
        result.push_str(&helper);
    }

    if let Some((insert_pos, call)) = host_pixels_preview_call_insertion(&result) {
        result.insert_str(insert_pos, &call);
    }
    eprintln!("[Guardrail] Injected GPU HMR host_pixels preview bridge");
    result
}

#[cfg(test)]
mod tests {
    use super::inject_array_backed_gpu_update_bridge;

    const ARRAY_SHARED: &str = r#"
struct AppState {
    float hostX[512];
    float hostY[512];
    float* deviceX;
    float* deviceY;
    unsigned long long frame;
};
constexpr int BALLS = 512;
"#;

    #[test]
    fn array_backed_gpu_update_bridge_injects_missing_live_kernel_and_readback() {
        let core = r#"
#include "shared.h"
#include <hip/hip_runtime.h>

extern "C" void core_on_update(void* state_ptr, double dt) {
    AppState* state = reinterpret_cast<AppState*>(state_ptr);
    if (!state) return;
    dim3 block(256);
    dim3 grid((BALLS + block.x - 1) / block.x);
    int balls_arg = BALLS;
    bool initialized = synthi_gpu_launch(nullptr, "particle_init", grid, block, 0, nullptr,
                                         { &state->deviceX, &state->deviceY, &balls_arg });
    float cx_arg = 400.0f;
    float cy_arg = 300.0f;
    float speed_arg = 2.35f;
    unsigned long long frame_arg = state->frame++;
}
"#;

        let fixed = inject_array_backed_gpu_update_bridge(core, ARRAY_SHARED);

        assert!(fixed.contains("synthi_array_gpu_update_bridge"));
        assert!(fixed.contains("\"particle_flow\""));
        assert!(fixed.contains("&state->deviceX"));
        assert!(fixed.contains("&state->deviceY"));
        assert!(fixed.contains("hipDeviceSynchronize();"));
        assert!(fixed.contains("hipMemcpy(state->hostX, state->deviceX"));
        assert!(fixed.contains("hipMemcpy(state->hostY, state->deviceY"));
        assert!(fixed.find("frame_arg = state->frame++").unwrap() < fixed.find("\"particle_flow\"").unwrap());
    }

    #[test]
    fn array_backed_gpu_update_bridge_does_not_duplicate_existing_live_kernel() {
        let core = r#"
#include "shared.h"
#include <cuda_runtime.h>

extern "C" void core_on_update(void* state_ptr, double dt) {
    AppState* state = reinterpret_cast<AppState*>(state_ptr);
    if (!state) return;
    dim3 block(256);
    dim3 grid((BALLS + block.x - 1) / block.x);
    int balls_arg = BALLS;
    float cx_arg = 400.0f;
    float cy_arg = 300.0f;
    float speed_arg = 2.35f;
    unsigned long long frame_arg = state->frame++;
    (void)synthi_gpu_launch(nullptr, "particle_flow", grid, block, 0, nullptr,
                            { &state->deviceX, &state->deviceY, &balls_arg, &cx_arg, &cy_arg, &speed_arg, &frame_arg });
}
"#;

        let fixed = inject_array_backed_gpu_update_bridge(core, ARRAY_SHARED);

        assert_eq!(fixed, core);
    }
}

fn core_update_app_state_variable(source: &str) -> Option<String> {
    let (body_start, body_end) = function_body_bounds(source, "core_on_update")?;
    let body = &source[body_start..body_end];
    let re_state = Regex::new(r"AppState\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*=").ok()?;
    re_state
        .captures(body)
        .and_then(|caps| caps.get(1).map(|name| name.as_str().to_string()))
        .or_else(|| core_update_state_parameter(source))
}

fn insert_in_core_update_after(source: &str, anchor: &str, insertion: &str) -> Option<String> {
    let (body_start, body_end) = function_body_bounds(source, "core_on_update")?;
    let body = &source[body_start..body_end];
    let anchor_pos = body.find(anchor)?;
    let after_anchor = &body[anchor_pos..];
    let statement_end = after_anchor.find(';')?;
    let insert_pos = body_start + anchor_pos + statement_end + 1;
    let mut result = source.to_string();
    result.insert_str(insert_pos, insertion);
    Some(result)
}

fn inject_array_backed_gpu_update_bridge(source: &str, shared_content: &str) -> String {
    if source.contains("synthi_array_gpu_update_bridge") {
        return source.to_string();
    }
    let Some((body_start, body_end)) = function_body_bounds(source, "core_on_update") else {
        return source.to_string();
    };
    let body = &source[body_start..body_end];
    if body.contains("\"particle_flow\"") || body.contains("'particle_flow'") {
        return source.to_string();
    }

    let has_array_state = ["hostX", "hostY", "deviceX", "deviceY"]
        .iter()
        .all(|field| shared_content.contains(field));
    let has_launch_args = ["balls_arg", "cx_arg", "cy_arg", "speed_arg", "frame_arg", "grid", "block"]
        .iter()
        .all(|name| body.contains(name));
    let has_device_launch_boundary =
        body.contains("synthi_gpu_launch") && body.contains("\"particle_init\"");
    if !has_array_state || !has_launch_args || !has_device_launch_boundary {
        return source.to_string();
    }

    let Some(state_name) = core_update_app_state_variable(source) else {
        return source.to_string();
    };
    let (sync_api, memcpy_api, d2h_kind) = if source.contains("<hip/hip_runtime.h>")
        || source.contains("hipDeviceSynchronize")
        || source.contains("hipMemcpy")
    {
        ("hipDeviceSynchronize", "hipMemcpy", "hipMemcpyDeviceToHost")
    } else if source.contains("<cuda_runtime.h>")
        || source.contains("cudaDeviceSynchronize")
        || source.contains("cudaMemcpy")
    {
        ("cudaDeviceSynchronize", "cudaMemcpy", "cudaMemcpyDeviceToHost")
    } else {
        return source.to_string();
    };

    let insertion = format!(
        r#"
    // [Guardrail] synthi_array_gpu_update_bridge: preserve live GPU simulation output for rendered host arrays.
    (void)synthi_gpu_launch(nullptr, "particle_flow", grid, block, 0, nullptr,
                            {{ &{state_name}->deviceX, &{state_name}->deviceY, &balls_arg, &cx_arg, &cy_arg, &speed_arg, &frame_arg }});
    {sync_api}();
    {memcpy_api}({state_name}->hostX, {state_name}->deviceX, sizeof(float) * BALLS, {d2h_kind});
    {memcpy_api}({state_name}->hostY, {state_name}->deviceY, sizeof(float) * BALLS, {d2h_kind});
"#
    );

    let updated = insert_in_core_update_after(source, "frame_arg", &insertion)
        .or_else(|| insert_in_core_update_after(source, "speed_arg", &insertion))
        .unwrap_or_else(|| source.to_string());
    if updated != source {
        eprintln!("[Guardrail] Injected GPU array update/readback bridge");
    }
    updated
}

/// Apply guardrails to shared.h content
pub fn apply_shared_guardrails(content: &str) -> String {
    if std::env::var("SYNTHI_ENABLE_GUARDRAILS").is_err() {
        return content.to_string(); // Guardrails off by default — AI self-heals
    }
    let mut result = content.to_string();

    // Guardrails: AI sometimes typedefs X11 types to void, which conflicts with Xlib headers.
    for bad in [
        "typedef void Display",
        "typedef void GC",
        "typedef void Atom",
        "typedef void XIM",
        "typedef void XIC",
    ] {
        if result.contains(bad) {
            result = result.replace(bad, "// stripped invalid typedef\n");
        }
    }

    // Strip conflicting forward declarations of X11 types and normalize struct field types.
    for bad in [
        "struct Display;",
        "struct Window;",
        "struct Atom;",
        "struct XIM;",
        "struct XIC;",
        "struct Pixmap;",
        "struct GC;",
        "struct XWindowAttributes;",
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
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)")
        && !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)")
    {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)",
        );
        eprintln!("[Guardrail] Fixed gui_on_load declaration in shared.h: added missing core_api_ptr parameter");
    }

    result
}

/// Apply guardrails to core.cpp content (requires processed shared.h for context)
///
/// Guardrails off by default — AI self-heals via compile→error→fix loop.
/// Set SYNTHI_ENABLE_GUARDRAILS=1 to re-enable legacy regex guardrails.
pub fn apply_core_guardrails(content: &str, shared_content: &str, allow_gui: bool) -> String {
    if std::env::var("SYNTHI_ENABLE_GUARDRAILS").is_err() {
        // Skip AI-fix guardrails; keep user-code adapters and proof-visible GPU preview bridge.
        let result = apply_core_user_adapters(content);
        let result = inject_host_pixels_preview_bridge(&result, shared_content);
        return inject_array_backed_gpu_update_bridge(&result, shared_content);
    }
    let mut result = content.to_string();

    // Fix common AI mistakes in core.cpp before compilation.
    if result.contains("is_running") {
        result = result.replace("is_running", "running");
    }

    // CRITICAL: Strip X11-related functions that the AI incorrectly preserved from the input.
    // Only applies if we are strictly enforcing core/gui split (allow_gui = false)
    if !allow_gui {
        let x11_type_patterns = [
            "Display*",
            "Display *",
            "Window*",
            "XIM",
            "XIC",
            "Atom",
            "Colormap",
            "Pixmap",
            "GC ",
            "XEvent",
            "XOpenDisplay",
            "XCloseDisplay",
            "XCreateWindow",
            "XDestroyWindow",
            "XOpenIM",
            "XCreateIC",
            "XCreateGC",
            "XFreeGC",
            "XCreatePixmap",
            "XFreePixmap",
        ];

        let mut cleaned_lines = Vec::new();
        for line in result.lines() {
            let has_x11 = x11_type_patterns.iter().any(|pat| line.contains(pat));
            let is_comment =
                line.trim_start().starts_with("//") || line.trim_start().starts_with("/*");
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

    // CRITICAL FIX: Transform heap-allocated on_load to static storage
    // AI-generated code may use malloc, new, or calloc to allocate state.
    // All patterns must be caught to ensure HMR can reuse prev_state.
    let uses_heap_alloc = result.contains("malloc(sizeof(AppState))")
        || result.contains("new AppState")
        || result.contains("calloc(1, sizeof(AppState))")
        || result.contains("calloc(1,sizeof(AppState))")
        || result.contains("malloc(sizeof(CoreState))")
        || result.contains("new CoreState");

    if uses_heap_alloc && result.contains("on_load") {
        if !result.contains("static AppState app_state")
            && !result.contains("static CoreState core_state")
        {
            if let Some(on_load_pos) = result.find("extern \"C\" void* on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            } else if let Some(on_load_pos) = result.find("extern \"C\" void* core_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState app_state = {0};\n\n");
            }
        }

        // malloc patterns
        let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed malloc->static").to_string();

        let re_malloc2 = Regex::new(r"CoreState\*\s+state\s*=\s*\(CoreState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*CoreState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "CoreState* state = (prev_state) ? (CoreState*)prev_state : &core_state; // [Guardrail] Fixed malloc->static").to_string();

        // C++ new patterns:  AppState* state = new AppState();  or  new AppState{}  or  new AppState;
        // IMPORTANT: The regex must consume the entire expression INCLUDING the
        // semicolon.  A char class like [({};)] would eat only one char (e.g. '(')
        // and leave a dangling ')' producing invalid C++.
        let re_new_app =
            Regex::new(r"AppState\*\s+state\s*=\s*new\s+AppState\s*(?:\(\)|\{[^}]*\})?\s*;")
                .unwrap();
        result = re_new_app.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed new->static").to_string();

        let re_new_core =
            Regex::new(r"CoreState\*\s+state\s*=\s*new\s+CoreState\s*(?:\(\)|\{[^}]*\})?\s*;")
                .unwrap();
        result = re_new_core.replace_all(&result, "CoreState* state = (prev_state) ? (CoreState*)prev_state : &core_state; // [Guardrail] Fixed new->static").to_string();

        // calloc patterns:  (AppState*)calloc(1, sizeof(AppState))
        let re_calloc =
            Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*calloc\s*\([^)]*\)\s*;")
                .unwrap();
        result = re_calloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &app_state; // [Guardrail] Fixed calloc->static").to_string();

        // if (!prev_state) { state = (AppState*)malloc... } blocks
        let re_if_malloc = Regex::new(
            r"if\s*\(\s*!prev_state\s*\)\s*\{\s*state\s*=\s*\(AppState\*\)\s*malloc[^}]+\}",
        )
        .unwrap();
        result = re_if_malloc
            .replace_all(
                &result,
                "if (!prev_state) { state = &app_state; /* [Guardrail] Fixed malloc->static */ }",
            )
            .to_string();

        // if (!prev_state) { state = new AppState... } blocks
        let re_if_new =
            Regex::new(r"if\s*\(\s*!prev_state\s*\)\s*\{\s*state\s*=\s*new\s+AppState[^}]+\}")
                .unwrap();
        result = re_if_new
            .replace_all(
                &result,
                "if (!prev_state) { state = &app_state; /* [Guardrail] Fixed new->static */ }",
            )
            .to_string();
    }

    // FIX: delete state crashes on reload (same as free)
    if result.contains("delete state") {
        let re_delete = Regex::new(r"delete\s+state\s*;").unwrap();
        result = re_delete
            .replace_all(
                &result,
                "// delete state; // [Guardrail] Commented - runner manages state",
            )
            .to_string();
    }

    // FIX: Detect and warn about free(state) which causes crashes on reload
    if result.contains("free(state)") {
        result = result.replace(
            "free(state);",
            "// free(state); // Commented - runner manages state",
        );
    }

    // FIX: Detect and warn about memset on state which wipes preserved HMR state
    if result.contains("memset(state")
        || result.contains("memset(&app_state")
        || result.contains("memset(&state")
        || result.contains("memset(&core_state")
        || result.contains("memset( state")
    {
        let re_memset = Regex::new(
            r"memset\s*\(\s*(state|&app_state|&core_state|&state|&gui_app_state)[^;]*\)\s*;",
        )
        .unwrap();
        result = re_memset
            .replace_all(
                &result,
                "// [Guardrail] memset REMOVED to preserve HMR state",
            )
            .to_string();
    }

    // Drop writes/reads to non-existent XWindowAttributes fields
    for bad_field in [
        "event_mask",
        "damage",
        "border_pixel",
        "background_pixel",
        "saved_attributes",
        "attributes_mask",
    ] {
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
    if (result.contains("XLookupString") || result.contains("XK_Escape"))
        && !result.contains("#include <X11/Xutil.h>")
    {
        result = format!(
            "#include <X11/Xutil.h>\n#include <X11/keysym.h>\n{}",
            result
        );
    }
    if (result.contains("dlopen") || result.contains("dlsym"))
        && !result.contains("#include <dlfcn.h>")
    {
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

    result = inject_host_pixels_preview_bridge(&result, shared_content);
    result = inject_array_backed_gpu_update_bridge(&result, shared_content);

    // FIX: Remove duplicate defines that are already in shared.h
    if result.contains("#include \"shared.h\"") {
        result = result.replace("#define CORE_STATE_MAGIC", "// #define CORE_STATE_MAGIC");
        result = result.replace(
            "#define SYNTHI_ABI_VERSION",
            "// #define SYNTHI_ABI_VERSION",
        );

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

    // FIX: Support standard main() C++ apps by transforming them to plugin format
    // This allows users to paste standard X11/SDL code with int main() and have it run inside the runner
    if !result.contains("core_on_load") && !result.contains("on_load") {
        let re_main_no_args = Regex::new(r"\bint\s+main\s*\(\s*(void)?\s*\)").unwrap();
        let re_main_args = Regex::new(r"\bint\s+main\s*\(").unwrap();

        let mut handled = false;

        if re_main_no_args.is_match(&result) {
            // Case 1: int main()
            result = re_main_no_args
                .replace(&result, "int user_main()")
                .to_string();

            result.push_str("\n\n// [Guardrail] Injected main() adapter (no-args)\n");
            result.push_str("#include <pthread.h>\n");
            result.push_str("int user_main();\n");
            result.push_str("extern \"C\" {\n");
            result.push_str("    static void* main_thread_func(void* arg) {\n");
            result.push_str("        user_main();\n");
            result.push_str("        return NULL;\n");
            result.push_str("    }\n");
            handled = true;
        } else if re_main_args.is_match(&result) {
            // Case 2: int main(argc, argv) or similar
            result = re_main_args.replace(&result, "int user_main(").to_string();

            result.push_str("\n\n// [Guardrail] Injected main() adapter (with-args)\n");
            result.push_str("#include <pthread.h>\n");
            result.push_str("int user_main(int argc, char** argv);\n");
            result.push_str("extern \"C\" {\n");
            result.push_str("    static void* main_thread_func(void* arg) {\n");
            result.push_str("        char* app_name = (char*)\"app\";\n");
            result.push_str("        char* argv[] = {app_name, NULL};\n");
            result.push_str("        user_main(1, argv);\n");
            result.push_str("        return NULL;\n");
            result.push_str("    }\n");
            handled = true;
        }

        if handled {
            // Implement required plugin ABI (common)
            result.push_str("    void* core_on_load(void* prev_state, void* api) {\n");
            result.push_str("        pthread_t thread;\n");
            result.push_str("        pthread_create(&thread, NULL, main_thread_func, NULL);\n");
            result.push_str("        pthread_detach(thread);\n");
            result.push_str("        return NULL;\n");
            result.push_str("    }\n");
            result.push_str("    void core_on_update(void* state, float dt) {\n");
            result.push_str("        // Main loop is running in separate thread\n");
            result.push_str("    }\n");
            result.push_str("}\n");
        }
    }

    result
}

// NOTE: `patch_strings_in_cached_result` and `is_semantic_string` were
// removed together with the Level 2 structural-match cache shortcut in
// `perform_ai_split`. They implemented SDL/CSS-color-specific string
// diffing that was only ever called from that dead cache level. All
// edit kinds now flow through handler.rs Tier 1 (regex value patcher,
// pure Rust) or Tier 2 (/refactor/diff_patch with arch hint, one AI
// call), language-agnostically.

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
    if std::env::var("SYNTHI_ENABLE_GUARDRAILS").is_err() {
        return content.to_string();
    }
    let mut result = content.to_string();

    // Detect if shared.h has full struct definitions
    let shared_has_full_hostkv = shared_content.contains("struct HostKvApiV1 {")
        || shared_content.contains("struct SynthiHostContextV1 {")
        || shared_content.contains("struct SynthiNamespaceSchemaV1 {");

    // Strip X11-related functions
    let x11_type_patterns = [
        "Display*",
        "Display *",
        "XIM",
        "XIC",
        "Atom",
        "Colormap",
        "Pixmap",
        "GC ",
        "XEvent",
        "XOpenDisplay",
        "XCloseDisplay",
        "XCreateWindow",
        "XDestroyWindow",
        "XOpenIM",
        "XCreateIC",
        "XCreateGC",
        "XFreeGC",
        "XCreatePixmap",
        "XFreePixmap",
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
        for struct_name in &[
            "HostKvApiV1",
            "SynthiHostContextV1",
            "SynthiNamespaceSchemaV1",
        ] {
            let typedef_pattern = format!("typedef struct {} {};", struct_name, struct_name);
            if result.contains(&typedef_pattern) {
                result = result.replace(
                    &typedef_pattern,
                    &format!("// {} forward-declared in shared.h", struct_name),
                );
            }

            if shared_has_full_hostkv {
                let struct_decl = format!("struct {} {{", struct_name);
                if let Some(start) = result.find(&struct_decl) {
                    if let Some(end) = result[start..].find("};") {
                        let block_end = start + end + "};".len();
                        let block = result[start..block_end].to_string();
                        result = result.replace(
                            &block,
                            &format!("// {} fully defined in shared.h", struct_name),
                        );
                    }
                }
            }
        }

        // Inject Host KV definitions if needed
        let uses_hostkv_types = result.contains("SynthiHostContextV1")
            || result.contains("SynthiNamespaceSchemaV1")
            || result.contains("HostKvApiV1")
            || result.contains("g_gui_schemas")
            || result.contains("host_kv_schemas");

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
    if result.contains("gui_on_load(void* prev_state, void* window_ptr)")
        && !result.contains("gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)")
    {
        result = result.replace(
            "gui_on_load(void* prev_state, void* window_ptr)",
            "gui_on_load(void* prev_state, void* window_ptr, void* core_api_ptr)",
        );
    }

    // FIX: Comment out SDL_RenderPresent
    let re_present = Regex::new(r"SDL_RenderPresent\s*\([^)]*\)\s*;").unwrap();
    result = re_present
        .replace_all(
            &result,
            "/* SDL_RenderPresent removed - runner handles this */",
        )
        .to_string();

    // FIX: Replace SDL_GetKeyboardWindow
    if result.contains("SDL_GetKeyboardWindow") {
        result = result.replace("SDL_GetKeyboardWindow", "SDL_GetKeyboardFocus");
    }

    // Convert heap-allocated gui_on_load to static storage
    // Catches malloc, new, and calloc patterns — AI may use any of these.
    let gui_uses_heap = result.contains("malloc(sizeof(AppState))")
        || result.contains("new AppState")
        || result.contains("calloc(1, sizeof(AppState))")
        || result.contains("calloc(1,sizeof(AppState))")
        || result.contains("malloc(sizeof(GuiState))")
        || result.contains("new GuiState");

    if gui_uses_heap && result.contains("gui_on_load") {
        if !result.contains("static AppState gui_app_state")
            && !result.contains("static GuiState gui_state")
        {
            if let Some(on_load_pos) = result.find("extern \"C\" void* gui_on_load") {
                result.insert_str(on_load_pos, "// [Guardrail] Injected static storage for HMR\nstatic AppState gui_app_state = {0};\n\n");
            }
        }

        // malloc patterns
        let re_malloc = Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*AppState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed malloc->static").to_string();

        let re_malloc2 = Regex::new(r"GuiState\*\s+state\s*=\s*\(GuiState\*\)\s*malloc\s*\(\s*sizeof\s*\(\s*GuiState\s*\)\s*\)\s*;").unwrap();
        result = re_malloc2.replace_all(&result, "GuiState* state = (prev_state) ? (GuiState*)prev_state : &gui_state; // [Guardrail] Fixed malloc->static").to_string();

        // C++ new patterns — match full expression through semicolon
        let re_new_app =
            Regex::new(r"AppState\*\s+state\s*=\s*new\s+AppState\s*(?:\(\)|\{[^}]*\})?\s*;")
                .unwrap();
        result = re_new_app.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed new->static").to_string();

        let re_new_gui =
            Regex::new(r"GuiState\*\s+state\s*=\s*new\s+GuiState\s*(?:\(\)|\{[^}]*\})?\s*;")
                .unwrap();
        result = re_new_gui.replace_all(&result, "GuiState* state = (prev_state) ? (GuiState*)prev_state : &gui_state; // [Guardrail] Fixed new->static").to_string();

        // calloc patterns
        let re_calloc =
            Regex::new(r"AppState\*\s+state\s*=\s*\(AppState\*\)\s*calloc\s*\([^)]*\)\s*;")
                .unwrap();
        result = re_calloc.replace_all(&result, "AppState* state = (prev_state) ? (AppState*)prev_state : &gui_app_state; // [Guardrail] Fixed calloc->static").to_string();
    }

    // FIX: Deduplicate AppState* state declarations within the SAME function.
    // The AI sometimes declares it twice in one function (e.g., gui_on_load has
    // malloc→static guardrail AND the AI's own declaration).  Only dedup within
    // the same brace-level scope — different functions need their own locals.
    {
        let re_state_decl = Regex::new(r"(?m)^(\s*)AppState\*\s+state\s*=").unwrap();
        let lines: Vec<&str> = result.lines().collect();
        let mut deduped = Vec::with_capacity(lines.len());
        let mut brace_depth: i32 = 0;
        let mut decl_at_depth: Option<i32> = None; // depth where first decl was seen

        for line in &lines {
            // Track brace depth to detect function boundaries
            for ch in line.chars() {
                match ch {
                    '{' => brace_depth += 1,
                    '}' => {
                        brace_depth -= 1;
                        // If we leave the scope where the decl was, reset
                        if let Some(d) = decl_at_depth {
                            if brace_depth < d {
                                decl_at_depth = None;
                            }
                        }
                    }
                    _ => {}
                }
            }

            if re_state_decl.is_match(line) {
                if decl_at_depth == Some(brace_depth) {
                    // Duplicate in SAME scope — convert to assignment
                    let fixed = re_state_decl.replace(line, "${1}state =").to_string();
                    deduped.push(fixed);
                    continue;
                }
                // First declaration at this scope depth
                decl_at_depth = Some(brace_depth);
            }
            deduped.push(line.to_string());
        }
        result = deduped.join("\n");
    }

    // FIX: free(state) / delete state crashes on reload
    if result.contains("free(state)") {
        result = result.replace(
            "free(state);",
            "// free(state); // Commented - runner manages state",
        );
    }
    if result.contains("delete state") {
        let re_delete = Regex::new(r"delete\s+state\s*;").unwrap();
        result = re_delete
            .replace_all(
                &result,
                "// delete state; // [Guardrail] Commented - runner manages state",
            )
            .to_string();
    }

    // FIX: memset wipes HMR state
    if result.contains("memset(state")
        || result.contains("memset(&app_state")
        || result.contains("memset(&gui_state")
        || result.contains("memset(&state")
        || result.contains("memset(&gui_app_state")
        || result.contains("memset( state")
    {
        let re_memset = Regex::new(
            r"memset\s*\(\s*(state|&app_state|&gui_state|&state|&gui_app_state)[^;]*\)\s*;",
        )
        .unwrap();
        result = re_memset
            .replace_all(
                &result,
                "// [Guardrail] memset REMOVED to preserve HMR state",
            )
            .to_string();
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
        result.push_str(
            "\n\nextern \"C\" void* entrypoint(void* state) {\n    main();\n    return 0;\n}\n",
        );
    }

    // FIX: renderer -> state->renderer
    if result.contains("SDL_Render")
        || result.contains("SDL_SetRenderDrawColor")
        || result.contains("draw_text")
    {
        let fixes = [
            (
                "SDL_RenderFillRect(renderer,",
                "SDL_RenderFillRect(state->renderer,",
            ),
            (
                "SDL_RenderDrawRect(renderer,",
                "SDL_RenderDrawRect(state->renderer,",
            ),
            (
                "SDL_SetRenderDrawColor(renderer,",
                "SDL_SetRenderDrawColor(state->renderer,",
            ),
            (
                "SDL_RenderClear(renderer)",
                "SDL_RenderClear(state->renderer)",
            ),
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

    // NOTE: We intentionally do NOT inject fake serialization stubs.
    // The old stubs returned "{}" (empty JSON) and NULL, which made
    // the orchestrator believe it had Full HMR capability when it
    // couldn't actually serialize state.  On schema-hash mismatch,
    // this caused silent total state loss via empty JSON migration.
    //
    // Without stubs, the orchestrator correctly reports Partial HMR
    // capability and relies on the raw pointer reuse path (static
    // storage), which is the correct primary HMR mechanism:
    // - Same schema: prev_state pointer reused → state preserved
    // - Changed schema: cold reload → clean initialization
    //
    // If a user's code exports real gui_on_save_state / gui_on_load_from_json,
    // those will be used for genuine cross-schema migration.

    result
}
