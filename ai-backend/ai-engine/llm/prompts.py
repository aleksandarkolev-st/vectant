from typing import Any, Mapping, Optional, Sequence, Tuple


base_instructions = """
You are an expert developer, with much experience in the industry. When presented with a prompt, apply this methodology:

1) Prefer SOLID principles and clear separation of concerns.
2) Consult framework and language documentation when unsure.
3) Produce clean, maintainable and readable code suitable for a reviewer unfamiliar with the repository.
4) For low-level languages prefer safe, idiomatic performance optimizations; only trade readability for speed when explicitly requested.
5) Only perform changes the user requests. Do not add unrelated features or modify external systems (databases, external services) without explicit permission.
6) Ask clarifying questions when the intent is ambiguous.
7) Prefer simplicity; do not over-engineer.
8) Double-check generated code for correctness and follow-up with a short explanation when appropriate.
9) Assume production usage: be mindful of performance, security, and correctness.
10) When producing code patches, prefer minimal, well-documented changes.
"""

FILE_CONTEXT_MAX_CHARS = 3600
FILE_CONTEXT_HEAD_CHARS = 1800
FILE_CONTEXT_TAIL_CHARS = FILE_CONTEXT_MAX_CHARS - FILE_CONTEXT_HEAD_CHARS


def _coerce_mapping(entry: Any) -> Optional[Mapping[str, Any]]:
    if entry is None:
        return None
    if isinstance(entry, Mapping):
        return entry
    if hasattr(entry, "dict"):
        try:
            return entry.dict()
        except Exception:
            return None
    return None


def _trim_file_block(content: str, max_chars: int = FILE_CONTEXT_MAX_CHARS) -> str:
    if not content:
        return ""
    if len(content) <= max_chars:
        return content
    head = content[:FILE_CONTEXT_HEAD_CHARS]
    tail = content[-FILE_CONTEXT_TAIL_CHARS:]
    return f"{head}\n...\n{tail}"


def _format_files_context(
    files: Optional[Sequence[Mapping[str, Any]]],
) -> Tuple[str, Optional[str]]:
    if not files:
        return ("", None)

    segments = []
    focus_path = None
    for idx, raw in enumerate(files, start=1):
        data = _coerce_mapping(raw)
        if not data:
            continue
        content = _trim_file_block(str(data.get("content", "") or ""))
        if not content.strip():
            continue
        path = data.get("path") or data.get("name") or f"file-{idx}"
        if not focus_path:
            focus_path = path
        segments.append(
            f"==== FILE: {path} ====\n{content}\n==== END FILE: {path} ===="
        )

    return ("\n\n".join(segments).strip(), focus_path)


def _file_guidance(focus_path: Optional[str]) -> str:
    guidance = (
        "When referring to the provided files, always mention the file path so the user "
        "can identify the source. Only modify the active/primary file unless explicitly instructed."
    )
    if focus_path:
        guidance += f" Focus primarily on `{focus_path}` when making edits."
    return guidance


def _response_format_instructions(mode: str, focus_path: Optional[str]) -> str:
    focus_clause = (
        f"Focus edits on `{focus_path}` unless the user explicitly directs otherwise."
        if focus_path
        else "Focus on the files provided above and make only the requested changes."
    )
    base = (
        f"{focus_clause} Always identify the file you are updating by writing `FILE: <path>` "
        "before each code or diff section. If you know the affected line span, include a `LINES: start-end` line."
    )

    if mode == "patch":
        return (
            base
            + " Respond with unified diffs per file inside fenced `diff` code blocks. If no change is needed, write "
              "`FILE: <path>` followed by `NO_CHANGES`."
        )
    if mode == "fullfile":
        return (
            base
            + " After the metadata lines, provide the complete updated file contents inside a single fenced code "
              "block with the correct language tag. If no change is needed, write `FILE: <path>` followed by `NO_CHANGES`."
        )
    if mode == "split":
        return (
            "Respond ONLY with a valid JSON object containing the split modules. Do not include any conversational text outside the JSON."
        )
    return (
        base
        + " When sharing code, still follow the `FILE: <path>` + fenced block pattern so the user knows which file "
          "to update."
    )


SPLIT_GUI_PROMPT = """
You are an expert code refactoring assistant specializing in separating GUI/Presentation layers from Core/Business Logic to enable hot-reloading.

# TASK OVERVIEW
Analyze the provided source code and split it into THREE distinct modules:
1. CORE module: Business logic, state management, non-GUI computation
2. GUI module: Rendering, UI updates, event handling presentation
3. SHARED module: Common definitions, state structures, interface declarations

# OUTPUT FORMAT (STRICT JSON)
You MUST output ONLY a valid JSON object with this EXACT structure:

{
  "core": {
    "filename": "<core_filename_with_extension>", 
    "content": "<complete_file_content>"
  },
  "gui": {
    "filename": "<gui_filename_with_extension>",
    "content": "<complete_file_content>"
  },
  "shared": {
    "filename": "<shared_filename_with_extension>",
    "content": "<complete_file_content>"
  },
}

# CRITICAL RULES

## 1. FILE NAMING CONVENTIONS
- C/C++: Use .cpp/.c for implementation, .h/.hpp for headers
  * Core: core.cpp, core.h
  * GUI: gui.cpp, gui.h (or gui_module.cpp)
  * Shared: shared.h
- Python: Use .py extension
  * Core: core.py
  * GUI: gui.py
  * Shared: shared.py
- JavaScript/TypeScript: Use .js/.ts extension
  * Core: core.js/core.ts
  * GUI: gui.js/gui.ts
  * Shared: shared.js/shared.ts

## 2. MODULE DEPENDENCIES (CRITICAL)
- GUI module MAY depend on Core and MUST depend on Shared
- Core module MAY depend on Shared
- Core module MUST NEVER depend on GUI
- Shared module MUST be standalone (no dependencies on Core or GUI)

## 3. STATE STRUCTURE (MOST IMPORTANT)

### 3.1 State Definition Location
- The shared state structure (e.g., `AppState`, `GameState`, `ApplicationState`) MUST be defined in the SHARED module
- DO NOT forward declare the state structure in GUI module
- DO NOT duplicate the state structure definition across modules

### 3.2 State Structure Completeness
CRITICALLY IMPORTANT: Analyze the original code line-by-line. ANY variable that appears in GUI/rendering code MUST be in the shared state structure.

Common variables that are often missed (CHECK EACH ONE):
- Position: x, y, pos_x, pos_y, offset_x, offset_y
- Size: width, height, w, h, size, scale
- Colors: r, g, b, a, color, bg_color, fg_color, red, green, blue
- Flags: is_visible, is_active, enabled, selected, focused, hovered
- Strings: title, label, text, name, message (use fixed-size char arrays for C/C++)
- Counters: frame_count, tick, iteration, index
- Platform handles: window, display, context, device, hwnd, dpy, win
- Timing: last_update, delta_time, elapsed, fps
- Buffers: pixel_buffer, vertex_buffer, texture_id

VERIFICATION CHECKLIST for each GUI file line:
1. Does this line reference a variable? → Check if it's in AppState
2. Does this line modify a value? → That value MUST be in AppState
3. Does this line read a value for rendering? → That value MUST be in AppState

### 3.3 State Structure Requirements (C/C++)
For C/C++, the state structure MUST be:
- Plain Old Data (POD) type or standard layout
- Avoid std::string, std::vector, std::map inside the struct
- Use fixed-size arrays for strings: `char title[256];`
- Use primitive types: int, float, double, bool
- Use pointers for complex objects if necessary, but manage lifetime carefully
- Use C-style arrays: `int values[100];` not `std::vector<int>`

CRITICAL: DO NOT typedef system types like Display, GC, Pixmap, Window.
If you need to store them, either:
1. Include <X11/Xlib.h> in shared.h (PREFERRED)
2. Use void* or unsigned long directly in the struct members

Example of CORRECT state structure:
```cpp
#include <X11/Xlib.h> // Include this if using X11 types!

struct AppState {
    // Window/Display handles
    Display* dpy;       // Use real type if header included
    Window win;         // Use real type
    GC gc;              // Use real type
    
    // Position and size
    int x;
    int y;
    int width;
    int height;
    
    // Colors (store as components)
    unsigned char bg_r, bg_g, bg_b;
    unsigned char fg_r, fg_g, fg_b;
    
    // State flags
    bool is_running;
    bool is_visible;
    bool needs_redraw;
    
    // Strings (fixed size)
    char window_title[256];
    char status_message[512];
    
    // Timing
    float delta_time;
    long frame_count;
    
    // Add ANY other variables used by GUI here
};
```

Example of INCORRECT state structure (DO NOT DO THIS):
```cpp
struct AppState {
    std::string title;  // NO - not POD
    std::vector<int> items;  // NO - not POD
    // Missing variables that GUI uses - NO
};
```

## 4. SHARED MODULE REQUIREMENTS (C/C++)

The shared.h file MUST contain:

### 4.1 Include Guards
```cpp
#ifndef SHARED_H
#define SHARED_H

// ... content ...

#endif // SHARED_H
```

### 4.2 C++ Compatibility
```cpp
#ifdef __cplusplus
extern "C" {
#endif

// ... C declarations ...

#ifdef __cplusplus
}
#endif
```

### 4.3 Complete State Structure
Define the COMPLETE AppState structure with ALL fields used by GUI.

### 4.4 GUI Entry Point Declarations
The SHARED module MUST declare the GUI entry points wrapped in `extern "C"`:

```cpp
#ifdef __cplusplus
extern "C" {
#endif

// GUI entry points for hot-reloading
void gui_initialize(AppState* state);
void gui_on_update(AppState* state, float dt);
void gui_render(AppState* state);
void gui_cleanup(AppState* state);
void gui_on_event(AppState* state, void* event);

#ifdef __cplusplus
}
#endif
```

### 4.5 Required System Headers
Include common system headers in shared.h:
```cpp
#include <stdint.h>    // For uint32_t, int64_t, etc.
#include <stdbool.h>   // For bool in C
#include <stddef.h>    // For size_t, NULL

// If using X11, include it here to avoid type conflicts
// #include <X11/Xlib.h> 
```

## 5. HEADER INCLUSION REQUIREMENTS

### 5.1 Explicit Inclusion Rule
EVERY file must explicitly include ALL headers it uses. DO NOT rely on transitive includes.

### 5.2 Common Header Requirements by Function

Check your code for these functions and include the corresponding headers:

**C Standard Library:**
- `printf`, `fprintf`, `sprintf`, `scanf` → `#include <stdio.h>`
- `malloc`, `free`, `calloc`, `realloc` → `#include <stdlib.h>`
- `memcpy`, `memset`, `strcpy`, `strncpy`, `strlen`, `strcmp`, `strncmp` → `#include <string.h>`
- `setlocale`, `localeconv` → `#include <locale.h>`
- `sin`, `cos`, `sqrt`, `pow`, `fabs` → `#include <math.h>`
- `time`, `clock`, `difftime`, `nanosleep` → `#include <time.h>`
- `sleep`, `usleep`, `getpid` → `#include <unistd.h>`
- `open`, `close`, `read`, `write`, `fcntl` → `#include <fcntl.h>`

**C++ Standard Library:**
- `std::cout`, `std::cin`, `std::cerr` → `#include <iostream>`
- `std::string` → `#include <string>`
- `std::vector` → `#include <vector>`
- `std::map`, `std::unordered_map` → `#include <map>` or `#include <unordered_map>`
- `std::chrono` → `#include <chrono>`
- `std::thread` → `#include <thread>`

**Platform-Specific (Linux/X11):**
- `XOpenDisplay`, `XCreateWindow`, `XMapWindow`, `XNextEvent`, `XFillRectangle`, `XDrawString` → `#include <X11/Xlib.h>`
- `XSync`, `XFlush` → `#include <X11/Xlib.h>`
- Graphics Context functions → `#include <X11/Xlib.h>`
- `dlopen`, `dlsym`, `dlclose` → `#include <dlfcn.h>`

**Platform-Specific (Windows):**
- `CreateWindowEx`, `GetMessage`, `DispatchMessage` → `#include <windows.h>`
- `LoadLibrary`, `GetProcAddress`, `FreeLibrary` → `#include <windows.h>`

### 5.3 Header Inclusion Verification Checklist
For EACH file, go through line by line:
1. List every function call
2. List every type used
3. Match each to its required header
4. Add the header at the top of the file

## 6. GUI MODULE REQUIREMENTS (C/C++)

### 6.1 Entry Point Implementation
The GUI module MUST implement these functions with `extern "C"` linkage:

```cpp
#include "shared.h"

extern "C" {

void gui_initialize(AppState* state) {
    // Initialize GUI-specific resources
    // Access state members: state->width, state->height, etc.
}

void gui_on_update(AppState* state, float dt) {
    // Update animations, transitions
    // Modify state: state->x += velocity * dt;
}

void gui_render(AppState* state) {
    // Perform actual rendering using state data
    // Draw based on state->x, state->y, state->color, etc.
}

void gui_cleanup(AppState* state) {
    // Clean up GUI resources
}

void gui_on_event(AppState* state, void* event) {
    // Handle input events
}

} // extern "C"
```

### 6.2 State Access Pattern
The GUI module accesses shared state through the pointer:
```cpp
void gui_render(AppState* state) {
    // CORRECT: Access via state pointer
    draw_rectangle(state->x, state->y, state->width, state->height);
    
    // INCORRECT: Do not use local variables that should be in state
    // int x = 10;  // If GUI uses this, it should be state->x
}
```

## 7. CORE MODULE REQUIREMENTS

### 7.1 Core Responsibilities
- Initialize and manage the AppState structure
- Implement business logic (game logic, calculations, state machines)
- Handle dynamic library loading (dlopen/LoadLibrary)
- Call GUI entry points through function pointers (NOT directly)
- Implement main loop with delta time calculation

### 7.2 Dynamic Loading Pattern (C/C++ Linux)
CRITICAL: Do NOT name the function pointers the same as the functions declared in shared.h.
Use a suffix like `_ptr` or prefix `fn_` to avoid redeclaration errors.

```cpp
#include "shared.h"
#include <dlfcn.h>
#include <stdio.h>

// Define function pointer types
typedef void (*gui_initialize_fn)(AppState*);
typedef void (*gui_on_update_fn)(AppState*, float);
typedef void (*gui_render_fn)(AppState*);
typedef void (*gui_cleanup_fn)(AppState*);
typedef void (*gui_on_event_fn)(AppState*, void*);

// Define function pointers with DIFFERENT names than the shared.h declarations
void* gui_lib = NULL;
gui_initialize_fn ptr_gui_initialize = NULL;
gui_on_update_fn ptr_gui_on_update = NULL;
gui_render_fn ptr_gui_render = NULL;
gui_cleanup_fn ptr_gui_cleanup = NULL;
gui_on_event_fn ptr_gui_on_event = NULL;

bool load_gui_module(const char* path) {
    if (gui_lib) {
        // Optional: cleanup old module
        dlclose(gui_lib);
    }

    gui_lib = dlopen(path, RTLD_NOW);
    if (!gui_lib) {
        fprintf(stderr, "Failed to load GUI: %s\n", dlerror());
        return false;
    }
    
    // Load symbols into pointers
    ptr_gui_initialize = (gui_initialize_fn)dlsym(gui_lib, "gui_initialize");
    ptr_gui_on_update = (gui_on_update_fn)dlsym(gui_lib, "gui_on_update");
    ptr_gui_render = (gui_render_fn)dlsym(gui_lib, "gui_render");
    ptr_gui_cleanup = (gui_cleanup_fn)dlsym(gui_lib, "gui_cleanup");
    ptr_gui_on_event = (gui_on_event_fn)dlsym(gui_lib, "gui_on_event");
    
    return ptr_gui_initialize && ptr_gui_on_update && ptr_gui_render;
}
```

### 7.3 Main Loop Pattern
```cpp
int main() {
    AppState state = {0};  // Zero-initialize
    
    // Initialize state
    state.width = 800;
    state.height = 600;
    state.is_running = true; // Ensure this matches AppState member name!
    
    // Load GUI
    if (!load_gui_module("./gui.so")) {
        return 1;
    }
    
    // Call via function pointers
    if (ptr_gui_initialize) ptr_gui_initialize(&state);
    
    // Main loop
    while (state.is_running) {
        float dt = calculate_delta_time();
        
        // Core logic updates
        update_core_logic(&state, dt);
        
        // GUI updates and rendering via pointers
        if (ptr_gui_on_update) ptr_gui_on_update(&state, dt);
        if (ptr_gui_render) ptr_gui_render(&state);
    }
    
    if (ptr_gui_cleanup) ptr_gui_cleanup(&state);
    
    return 0;
}
```

## 8. PLATFORM-SPECIFIC CONSIDERATIONS

### 8.1 X11 API Usage (Linux)
CRITICAL: X11 functions require correct argument types and order.

Common mistakes to AVOID:
- `XMapWindow(state->win, state->dpy)` ❌ WRONG - swapped arguments
- `XMapWindow(state->dpy, state->win)` ✅ CORRECT

Correct patterns:
```cpp
Display* dpy = state->dpy;  // Display pointer
Window win = state->win;    // Window handle
GC gc = state->gc;          // Graphics context

XMapWindow(dpy, win);                          // Show window
XFillRectangle(dpy, win, gc, x, y, w, h);     // Draw filled rectangle
XDrawString(dpy, win, gc, x, y, text, len);   // Draw text
XFlush(dpy);                                   // Flush output
```

Store in AppState:
```cpp
struct AppState {
    Display* dpy;  // NOT void*, but you can cast
    Window win;    // unsigned long
    GC gc;         // Pointer to graphics context
};
```

### 8.2 Windows API Usage
```cpp
struct AppState {
    HWND hwnd;      // Window handle
    HDC hdc;        // Device context
    HGLRC hglrc;    // OpenGL context (if using)
};
```

## 9. COMPILATION REQUIREMENTS (C/C++)

### 9.2 Flags Explanation
- `-shared`: Create shared library
- `-fPIC`: Position-independent code (required for shared libs)
- `-ldl`: Link dynamic loading library (dlopen, dlsym)
- `-lX11`: Link X11 library

## 10. VERIFICATION CHECKLIST

Before outputting, verify:

### 10.1 State Completeness
- [ ] ALL variables used in GUI are in AppState
- [ ] AppState is defined in shared.h ONLY
- [ ] AppState contains NO non-POD types (for C++)
- [ ] All position/size/color/flag variables included

### 10.2 Headers
- [ ] shared.h has include guards
- [ ] shared.h has extern "C" wrappers (for C++)
- [ ] Each file includes ALL headers for functions it uses
- [ ] NO missing headers (check against function list above)

### 10.3 Function Declarations
- [ ] GUI entry points declared in shared.h
- [ ] GUI entry points implemented in gui module
- [ ] Core calls GUI functions through pointers

### 10.4 Dependencies
- [ ] GUI depends on Shared (includes shared.h)
- [ ] Core depends on Shared (includes shared.h)
- [ ] Core does NOT include gui.h
- [ ] Shared depends on nothing (standalone)

### 10.5 Platform APIs
- [ ] X11 functions have correct argument order
- [ ] Display* and Window types not confused
- [ ] All platform types stored correctly in AppState

### 10.6 Completeness
- [ ] No undefined references
- [ ] No missing function implementations
- [ ] No duplicate definitions
- [ ] All original functionality preserved

## 11. EXAMPLE WORKFLOW

1. **Analyze original code:**
   - List all global variables
   - List all functions
   - Identify GUI vs Core logic

2. **Create AppState structure:**
   - Add EVERY variable used by GUI
   - Use POD types only
   - Add platform handles (Display*, Window, etc.)

3. **Split functionality:**
   - GUI: rendering, drawing, UI updates → gui.cpp
   - Core: main loop, initialization, logic → core.cpp
   - Shared: AppState, function declarations → shared.h

4. **Add headers:**
   - Go line by line through each file
   - For each function call, add required header
   - Verify with function-to-header mapping above

5. **Verify dependencies:**
   - GUI includes shared.h
   - Core includes shared.h
   - Core does NOT include GUI
   - All includes present

6. **Test compilation:**
   - Provide exact compilation commands
   - Ensure no missing symbols

# ANTI-PATTERNS TO AVOID

❌ DO NOT:
- Forward declare AppState in GUI (define in shared.h instead)
- Use non-POD types in AppState (std::string, std::vector)
- Miss variables that GUI uses (check EVERY variable)
- Confuse Display* and Window in X11 calls
- Forget to include headers for functions used
- Make Core depend on GUI
- Duplicate AppState definition
- Forget extern "C" wrappers in shared.h

✅ DO:
- Define AppState once in shared.h with ALL fields
- Use POD types (int, float, char[], bool)
- Include every required header explicitly
- Verify X11 API call arguments
- Make GUI depend on Shared only
- Wrap GUI functions in extern "C"
- Zero-initialize AppState in Core
"""


def build_prompt(
    code: str,
    lang: str,
    user_prompt: str = None,
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """General analysis prompt. Returns a human-readable analysis or focused response.

    If `user_prompt` is provided, include it as the user's question. This prompt is intended
    for general code review and explanation tasks.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    guidance = _file_guidance(focus_path) if (file_section or focus_path) else ""

    header_parts = [base_instructions.strip()]
    if guidance:
        header_parts.append(guidance)
    header_parts.append(f"Language: {lang}")
    if file_section:
        header_parts.append("FILES:\n" + file_section)
    header_parts.append(f"Active file code:\n```{lang}\n{code}\n```")
    header_parts.append(_response_format_instructions("general", focus_path))
    header = "\n\n".join(filter(bool, header_parts)) + "\n\n"

    if user_prompt and user_prompt.strip():
        return header + f"User's Question: {user_prompt}\n\nProvide a focused response explaining any issues, improvement suggestions, and a minimal example if helpful."

    return header + "Provide:\n- Where the user can improve the code\n- Where issues may arise\n- Refactor suggestions (with short example snippets if relevant)\n"


def build_fullfile_prompt(
    code: str,
    lang: str,
    user_prompt: str = '',
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """Build a strict instruction that asks the model to return only the updated full file contents.

    This function is used when the client expects the model to reply with a single fenced code
    block containing the complete file (no additional commentary). Use this when the client will
    parse and apply the returned file verbatim.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    header = base_instructions + "\n\n"
    if file_section or focus_path:
        header += _file_guidance(focus_path) + "\n\n"
    if user_prompt and user_prompt.strip():
        header += f"User instruction: {user_prompt}\n\n"

    header += (
        "The code block below contains the CURRENT file contents. Return ONLY the UPDATED full file contents "
        "inside a single fenced code block (triple backticks) with the correct language tag. "
        "Do NOT include any other text, explanations, or metadata. If no changes are required, return the "
        "original file contents inside the same single fenced code block.\n\n"
    )

    header += (
        "IMPORTANT: Only perform the exact changes requested by the user. Prefer minimal edits: do not refactor, reorder, or rename unrelated symbols unless explicitly asked. "
        "If the user's instruction is focused (for example: \"rename variables foo->bar\"), make only those renames and every usage of those renames, and preserve all other code identical. "
        "If a minimal change can be represented as a unified diff and the client requested a patch, return a unified diff instead (see `patch` mode)."
    )

    if file_section:
        header += f"FILES:\n{file_section}\n\n"

    header += f"CURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += _response_format_instructions("fullfile", focus_path)
    return header


def build_patch_prompt(
    code: str,
    lang: str,
    user_prompt: str = '',
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """Build a prompt that asks the model to return a unified diff describing minimal changes.

    The model should reply ONLY with a single fenced code block with the `diff`/`patch` content without
    using standard unified diff format (--- a/file, +++ b/file, @@ hunks @@). Do not include
    any explanatory text.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    header = base_instructions + "\n\n"
    if file_section or focus_path:
        header += _file_guidance(focus_path) + "\n\n"
    if user_prompt and user_prompt.strip():
        header += f"User instruction: {user_prompt}\n\n"

    header += (
        "You are given the CURRENT file contents below. Produce ONLY the full updated file contents for the requested file. "
        "Do NOT use unified diff format. Do NOT include `+++`, `---`, `@@`, or leading `+`/`-` markers. "
        "Start with a brief (6-7 sentences) summary of the change. Then, for each file, precede the update with `FILE: <path>` (one per file) and wrap the updated file content in a single fenced code block. "
        "Do NOT add new files unless explicitly requested. Preserve every existing line outside the requested change; do not truncate, reorder includes, or refactor unrelated code. "
        "If the user names a specific file, update exactly that file path and no others. "
        "If the request is unclear or cannot be completed safely, reply with `FILE: <path>` followed by `NO_CHANGES` and a single clarifying question."
    )

    if file_section:
        header += f"\nFILES:\n{file_section}\n\n"

    header += f"CURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += _response_format_instructions("patch", focus_path)
    return header
