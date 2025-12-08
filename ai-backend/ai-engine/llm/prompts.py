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

CRITICAL: DO NOT forward declare X11 types if you include <X11/Xlib.h>.
- BAD: `typedef struct XEvent XEvent;` (Conflicts with Xlib.h)
- GOOD: Just include `<X11/Xlib.h>` and use `XEvent`.

### 3.4 VARIABLE NAMING (CRITICAL)
- You MUST use the EXACT same name for the variable in `AppState` as it was in the global scope.
  * Original: `int player_x;` -> AppState: `int player_x;`
  * BAD: `int player_x;` -> AppState: `int x;` or `int playerX;`
- Do NOT prefix variables with `m_` or `_`.
- Do NOT rename `wbuffer` to `input_buffer`. Keep it `wbuffer`.

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

## 4. EVENT LOOP HANDLING (CRITICAL)
- The RUNNER handles the main X11 event loop.
- The CORE module MUST implement `extern "C" void on_event(void* state, void* event)` to receive events from the runner.
- The CORE module MUST forward these events to the GUI module via `ptr_gui_on_event`.
- DO NOT call `XNextEvent` or `XPending` in `on_update`. This will steal events from the runner and cause freezing.
- DO NOT implement your own event loop.

## 5. STABILITY & COMPATIBILITY (CRITICAL)
- **THREAD SAFETY**: You MUST call `XInitThreads()` before `XOpenDisplay`.
  * This is required because the runner uses GStreamer (multi-threaded) alongside X11.
  * Example:
    ```cpp
    if (!state->dpy) {
        XInitThreads(); // <--- CRITICAL
        state->dpy = XOpenDisplay(NULL);
    }
    ```
- **DISABLE XIM/XIC**: Do NOT use XInputMethod (XIM) or XInputContext (XIC). They cause freezes in headless/container environments.
  * Initialize `xim` and `xic` to `NULL` if they exist in the struct.
  * Do NOT call `XOpenIM` or `XCreateIC`.
  * Do NOT call `XFilterEvent`.
  * Use `XLookupString` (not `XwcLookupString`) for key events.
- **EVENT MASKS**: In `XSelectInput`, ALWAYS include `PointerMotionMask` to ensure mouse movements are received.
  * Example: `XSelectInput(dpy, win, ExposureMask | KeyPressMask | ButtonPressMask | StructureNotifyMask | PointerMotionMask);`

## 6. MEMORY MANAGEMENT (CRITICAL)
- **DO NOT FREE STATE ON UNLOAD**: The `on_unload` function MUST NOT free the `AppState` memory.
  * The state pointer is passed to the next version of the library during hot-reloading.
  * If you free it, the next version will crash or freeze when accessing invalid memory.
  * Let the operating system reclaim the memory when the process terminates.
  * Example:
    ```cpp
    extern "C" void on_unload(void* state_ptr) {
        // Cleanup resources (textures, windows, etc.) if necessary
        // BUT DO NOT CALL free(state_ptr);
    }
    ```

Example of INCORRECT state structure (DO NOT DO THIS):
```cpp
struct AppState {
    std::string title;  // NO - not POD
    std::vector<int> items;  // NO - not POD
    // Missing variables that GUI uses - NO
};
```

## 3.5 CODE PRESERVATION (ZERO TOLERANCE)
- DO NOT RENAME VARIABLES. You must use the EXACT same names as the original code.
- DO NOT CHANGE VALUES. Constants, initializers, and logic must remain identical.
- DO NOT REFACTOR LOGIC unless strictly necessary for the split.
- PRESERVE COMMENTS where possible.
- STABILITY: If you are re-running on similar code, try to keep the output structure identical to minimize changes.
- PRESERVE STRING LITERALS: Do not correct typos, change text, or "improve" messages. If the user code says `printf("dsdas")`, you MUST output `printf("dsdas")`.
- PRESERVE MAGIC NUMBERS: Do not replace hardcoded numbers with variables unless absolutely necessary. If the code says `if (x > 590)`, keep `590`. Do NOT change it to `width - 50`.
- NO NEW COMMENTS: Do NOT add any new comments or explanations to the generated code. Only preserve existing comments from the source code.
- NO MODERNIZATION: Do not change C style code to C++ style (e.g. keep `malloc`/`free`, do not change to `new`/`delete`). Keep `printf` instead of changing to `std::cout`.
- COPY-PASTE PREFERENCE: When moving function bodies, copy them exactly as is.

## 3.6 STATE PERSISTENCE & MIGRATION
- You MUST implement `extern "C" void* on_load(void* prev_state, void* display_ptr)` in the GUI or CORE module (whichever holds the state).
- If `prev_state` is not null, you MUST cast it to `AppState*` and use it.
- If `prev_state` is null, allocate new state and initialize it.
- **CRITICAL**: You MUST use the provided `display_ptr` (cast to `Display*`) for X11 operations.
- **CRITICAL**: DO NOT call `XOpenDisplay(NULL)` yourself. Use the provided display pointer.
- Ensure `AppState` struct definition in `shared.h` matches the original variables exactly to allow safe casting.

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
- MINIMAL MOVEMENT: Only move `#include` directives to `shared.h` if they are required for types defined in `AppState`. Keep other includes in `core.cpp` or `gui.cpp` where they are used.

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
The GUI module MUST implement these functions with `extern "C"` linkage.

CRITICAL: Implement "Lazy Initialization" for the window. Check if it exists in state before creating it.
CRITICAL: Implement "Persistent Cleanup". Do NOT destroy the window on cleanup.

```cpp
#include "shared.h"

extern "C" {

void gui_initialize(AppState* state) {
    // 1. Lazy Window Creation
    // Only create the window if it doesn't exist in the state yet.
    // This prevents flickering during hot-reload.
    if (state->window == 0) {
        // CRITICAL: Use state->dpy which was set in on_load. DO NOT open a new display.
        // state->window = XCreateSimpleWindow(state->dpy, ...);
        // XMapWindow(state->dpy, state->window);
        
        // Initialize Input Method (XIM) if needed
        // state->xim = XOpenIM(state->dpy, NULL, NULL, NULL);
        // state->xic = XCreateIC(state->xim, ...);
    }
    
    // 2. Initialize other resources (fonts, textures, GCs)
    // CRITICAL: Create GCs and Pixmaps HERE, not in gui_render.
    // if (!state->gc) state->gc = XCreateGC(state->dpy, state->window, 0, NULL);
}

void gui_on_update(AppState* state, float dt) {
    // Update animations, transitions
    // Modify state: state->x += velocity * dt;
}

void gui_render(AppState* state) {
    // Perform actual rendering using state data
    // Draw based on state->x, state->y, state->color, etc.
    
    // CRITICAL: DO NOT CREATE RESOURCES HERE (GC, Pixmap, Font).
    // Use resources created in gui_initialize and stored in AppState.
}

void gui_cleanup(AppState* state) {
    // Clean up textures, fonts, buffers
    
    // CRITICAL: DO NOT DESTROY THE WINDOW
    // The window must persist for the next module version.
    // XDestroyWindow(state->dpy, state->window); // <--- DO NOT DO THIS
}

void gui_on_event(AppState* state, void* event) {
    // Handle input events
    // XEvent* ev = (XEvent*)event;
    // if (state->xim && state->xic && XFilterEvent(ev, state->window)) return;
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

CRITICAL: When accessing arrays in AppState, you MUST use `state->array_name`.
Example:
- Original: `wbuffer[0] = '\0';`
- Correct: `state->wbuffer[0] = '\0';`
- Incorrect: `wbuffer[0] = '\0';` (This will cause a compilation error!)

### 6.3 Window Persistence (CRITICAL)
To prevent flickering during hot-reloading, the window handle MUST persist in `AppState`.
1. In `gui_initialize`: Check `if (!state->window)` before creating a new window.
2. In `gui_cleanup`: Do NOT call `XDestroyWindow` or `CloseWindow`. Leave the window open for the next version of the library.

## 7. CORE MODULE REQUIREMENTS

### 7.1 Core Responsibilities
- Initialize and manage the AppState structure
- Implement business logic (game logic, calculations, state machines)
- Handle dynamic library loading (dlopen/LoadLibrary)
- Call GUI entry points through function pointers
- **CRITICAL: DO NOT IMPLEMENT `main()`**. You must implement `on_load`, `on_update`, and `on_unload` to be driven by the host runner.
- **CRITICAL: NEVER call `gui_initialize`, `gui_on_update`, etc. directly. ALWAYS use the function pointers `ptr_gui_initialize`, `ptr_gui_on_update`, etc.**

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

// Define function pointers
void* gui_lib = NULL;
gui_initialize_fn ptr_gui_initialize = NULL;
gui_on_update_fn ptr_gui_on_update = NULL;
gui_render_fn ptr_gui_render = NULL;
gui_cleanup_fn ptr_gui_cleanup = NULL;
gui_on_event_fn ptr_gui_on_event = NULL;

bool load_gui_module(const char* path) {
    // Safer reload: Load new lib first, then close old one
    void* new_lib = dlopen(path, RTLD_NOW);
    if (!new_lib) {
        fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return false;
    }
    
    if (gui_lib) dlclose(gui_lib);
    gui_lib = new_lib;
    
    ptr_gui_initialize = (gui_initialize_fn)dlsym(gui_lib, "gui_initialize");
    ptr_gui_on_update = (gui_on_update_fn)dlsym(gui_lib, "gui_on_update");
    ptr_gui_render = (gui_render_fn)dlsym(gui_lib, "gui_render");
    ptr_gui_cleanup = (gui_cleanup_fn)dlsym(gui_lib, "gui_cleanup");
    ptr_gui_on_event = (gui_on_event_fn)dlsym(gui_lib, "gui_on_event");
    
    return ptr_gui_initialize && ptr_gui_on_update && ptr_gui_render;
}
```

### 7.3 Core Entry Points (NO MAIN FUNCTION)
The Core module MUST implement these `extern "C"` functions to be driven by the runner:

```cpp
// Global state instance
AppState app_state = {0};

extern "C" void* on_load(void* prev_state, void* display_ptr) {
    if (prev_state) {
        // Migrate state
        AppState* old = (AppState*)prev_state;
        app_state = *old; // Copy POD state
        // Ensure display pointer is updated (in case it changed, though unlikely)
        app_state.dpy = (Display*)display_ptr;
    } else {
        // Initialize new state
        app_state.is_running = true;
        app_state.width = 800;
        app_state.height = 600;
        // CRITICAL: Use the provided display pointer
        app_state.dpy = (Display*)display_ptr;
    }
    
    // Load GUI module
    if (load_gui_module("./gui.so")) {
        if (ptr_gui_initialize) ptr_gui_initialize(&app_state);
    }
    
    return &app_state;
}

extern "C" void on_update(void* state_ptr, double dt) {
    // Core logic updates
    update_core_logic(&app_state, (float)dt);
    
    // GUI updates and rendering
    if (ptr_gui_on_update) ptr_gui_on_update(&app_state, (float)dt);
    if (ptr_gui_render) {
        ptr_gui_render(&app_state);
        // CRITICAL: Flush X11 buffer to ensure rendering is visible
        if (app_state.dpy) XFlush(app_state.dpy);
    }
}

extern "C" void on_event(void* state_ptr, void* event_ptr) {
    if (ptr_gui_on_event) ptr_gui_on_event(&app_state, event_ptr);
}

extern "C" void on_unload(void* state_ptr) {
    if (ptr_gui_cleanup) ptr_gui_cleanup(&app_state);
    if (gui_lib) dlclose(gui_lib);
}
```

## 8. PLATFORM-SPECIFIC CONSIDERATIONS

### 8.1 X11 API Usage (Linux)
CRITICAL: X11 functions require correct argument types and order.

Common mistakes to AVOID:
- `XMapWindow(state->win, state->dpy)` ❌ WRONG - swapped arguments
- `XMapWindow(state->dpy, state->win)` ✅ CORRECT
- Assigning `Screen*` to `int`. `XWindowAttributes.screen` is `Screen*`. `DefaultScreen(dpy)` is `int`.
  - Use `XScreenNumberOfScreen(wa.screen)` if you need the int index from attributes.

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
   - Core: initialization, logic, update loop body (NO blocking main loop) → core.cpp
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
