# HMR Lightning Ultraplan — Runtime HMR that feels instant

**Companion to**: `HMR_AGNOSTIC_ULTRAPLAN.md` (already shipped — made the BUILD pipeline library-agnostic).
**Scope**: make the RUNTIME HMR (a) work for any C++ library, not just SDL2, and (b) feel instant — sub-20ms for value edits, sub-200ms for structural edits, across every supported library.
**Status**: drafting. Branch: TBD after approval.

---

## 0. TL;DR

Four phases, sequenced for maximum UX win per day of effort:

| # | Phase | Effort | Latency win | Coverage win |
|---|---|---|---|---|
| 9  | **g++ compile acceleration** (ccache + PCH + parallel compile + `.o` caching) | 3-5 days | ~600ms → ~100ms on cold structural edit | none |
| 10 | **Path A — library-aware runner** (extract `WindowBackend` trait; ship GLFW, raylib, sokol, SFML backends) | 5-7 days for first three + 1-2 days each extra | none | unlocks runtime HMR for 5+ libraries |
| 11 | **Binary patching for value edits** (skip g++ entirely, patch `.so` literals in the live runner process) | 1-2 weeks | ~600ms → ~20ms on value edits (~60% of real edits) | none |
| 12 | **Path C — supervisor + child process** (zero-day libraries + true BYOR, via Xvfb capture of child runner) | ~2 weeks | +50-100ms tax on long-tail libraries (acceptable) | unlocks any library the AI can compile |

**Recommended sequence**: 9 → 11 → 10 → 12. Reasoning under §9.

**End state**: after all four phases, a user editing any C++ project (SDL2, GLFW, raylib, sokol, SFML, or something genuinely novel) experiences:
- **Value tweaks** (color, number, string literal): ~20ms — visually instant
- **Structural edits** (new function, changed logic): ~150-250ms — fast enough not to break flow
- **First compile per session**: 1-3s — unavoidable cold cost, matches today's SDL2 floor

Reference latency target: **the Figma/Linear feel** — edits land before you're done thinking about them.

---

## 1. Goal & Success Criteria

### 1.1 Goal

When a user saves a change in the Synthi IDE, the visible result in the runner-streamed video should be indistinguishable from a live preview — no perceptible delay, no flash, no stutter, regardless of what framework/library the project uses.

### 1.2 Success criteria

Quantitative:
- **Value-edit HMR p50**: ≤25ms measured from save→first rendered frame with new value
- **Value-edit HMR p99**: ≤60ms
- **Structural-edit HMR p50**: ≤250ms
- **Structural-edit HMR p99**: ≤600ms
- **Library coverage at runtime**: SDL2, GLFW, raylib, sokol, SFML, ImGui+SDL all pass the full Phase 7 corpus in end-to-end mode (not just build-time)
- **Zero-day library coverage**: any library the AI can compile (Phase 4.5 validator pass) works via Path C with ≤500ms additional worst-case latency
- **No regressions**: the existing SDL2 happy path stays under today's ~370ms p50

Qualitative:
- "I can't tell which library my project uses from the HMR speed."
- "Tweaking colors feels like dragging a slider, not saving a file."
- "I didn't have to pick a library when I started the project — it just worked."

### 1.3 Out of scope

- Languages other than C/C++ (language-parameterisation is post-V2)
- Runtime HMR for compiled languages without dynamic linking (Rust, Go, Zig without `-dynamic`)
- True multi-step build systems (CMake, Meson, Qt MOC) — still rejected cleanly per Phase 3 mitigation
- Remote runners (HMR across network boundary) — post-V3

---

## 2. Where we are vs where we're going

### 2.1 What shipped in `HMR_AGNOSTIC_ULTRAPLAN.md`

Build-time is library-agnostic. Concretely:

- **Phase 1-3**: AI produces a 4-file split (`shared.h`, `core.cpp`, `gui.cpp`, `host_runner.cpp`) + a build manifest describing compiler / flags / link flags / hot_reload_mode. Worker uses the manifest instead of hardcoded SDL2 values. Any C++ library, any compiler, any flags.
- **Phase 4**: `host_runner.cpp` is compiled into a per-project executable as a build artifact. Not spawned at runtime yet (see §2.2).
- **Phase 4.5**: pre-flight include→link validator ensures every `#include <X.h>` has a matching `-lX` flag or an explicit notes excuse. Rejects impossible manifests before compile.
- **Phase 5**: Tier 2 diff-patch accepts `host_runner` as a 4th edit target, so hot edits to window code get routed correctly.
- **Phase 6**: if the linker reports undefined references at compile time, the manifest heal loop asks the AI to add the missing flag and retries once. No library catalog — the AI infers from symbol names + source.
- **Phase 7**: 11-project corpus + pytest suite + CI workflow gate on prompt/manifest changes.
- **Phase 8**: frontend displays the AI-detected framework name in the status bar, BYOR toggle, confidence warning, manifest rejection error card.

159 offline tests + 11 live-integration tests, all green. Build pipeline: done.

### 2.2 The runtime gap

Runtime is SDL2-centric. Concretely:

- `worker/src/runtime/runner_bin.rs` — the shipped binary that spawns at runtime — creates an SDL2 window itself via X11/Xvfb, runs its own event loop, dlopens `libcore.so` + `libgui.so`, and streams video via GStreamer captured from the SDL2 window handle.
- If the user's project is GLFW-based: the `.so` files get produced correctly (Phase 3 works), but at runtime the shipped `runner_bin` opens an SDL2 window. Inside `libgui.so`, the `gui_on_render` function tries to call `glfwSwapBuffers` against a window that doesn't exist → crash or hang.
- The per-project `host_runner_<timestamp>` binary compiled in Phase 4 sits unused on disk.

The four phases in this plan close that gap — and, as a bonus, shave 90%+ off the latency floor for the common case.

### 2.3 What "runtime" actually encompasses

Three sub-systems have to work together:

1. **Window + event loop host**: creates a window the user's code can draw to, pumps events into it. Today: SDL2 hardcoded in `runner_bin`.
2. **Module reload mechanism**: dlclose/dlopen the `.so` files when they change, remap function pointers, migrate state across the reload. Today: works for any library as long as the library itself is swap-safe (Phase 4 `hot_reload_mode` covers process-restart libraries).
3. **Video streaming pipeline**: capture the rendered frames and send them to the browser via WebRTC. Today: Xvfb + GStreamer, captures from the shipped runner's SDL2 window.

Phase 10 (Path A) extends sub-system 1 to N libraries via a trait. Phase 11 sidesteps all three by patching the `.so` in place — no reload needed. Phase 12 decouples sub-system 1 from the supervisor so sub-system 3 captures generically (any X11 window).

---

## 3. The latency budget

### 3.1 Current floor (SDL2 happy path, post-`HMR_AGNOSTIC_ULTRAPLAN.md`)

Value edit (Phase 5 speculation hit, Tier 1 regex patcher):
```
debounce (frontend)              ~200ms  [masked — speculation fires during this]
apply cached edit                  ~1ms
g++ on patched core.cpp          ~300ms  ← 80% of total, unavoidable with current path
g++ on patched gui.cpp           ~300ms
dlclose + dlopen                  ~50ms
next frame render                 ~16ms
─────────────────────────────────────────
total user-perceived            ~670ms
```

Structural edit (Phase 5 Tier 2 diff-patch, AI call was speculative):
```
debounce                         ~200ms  [masked]
apply edit list                    ~5ms
g++ full recompile               ~600ms
dlclose + dlopen                  ~50ms
next frame                        ~16ms
─────────────────────────────────────────
total                            ~870ms
```

The dominant cost on both paths is g++. Everything upstream is already fast after the Phase 5 speculation work.

### 3.2 Target floor after all four phases

Value edit (Phase 11 binary patch path):
```
debounce                         ~200ms  [masked]
classify edit as value-only        ~1ms
DWARF lookup for literal           ~2ms
layout stability check             ~1ms
mprotect + memcpy + icache flush   ~2ms
IPC round-trip to runner           ~5ms
next frame                        ~16ms
─────────────────────────────────────────
total user-perceived             ~27ms  ← 25x faster
```

Structural edit (Phase 9 compile-optimized path):
```
debounce                         ~200ms  [masked]
apply edit list                    ~5ms
incremental g++ via ccache + PCH  ~80ms  ← 300ms → 80ms
parallel compile of unchanged     ~0ms  (cache hit)
link unchanged .so                ~30ms
dlclose + dlopen                  ~50ms
next frame                        ~16ms
─────────────────────────────────────────
total                           ~181ms  ← 4.8x faster
```

Zero-day library edit (Phase 12 via Path C):
```
debounce                         ~200ms  [masked]
apply edit list                    ~5ms
compile via Phase 9 path          ~80ms
IPC to child runner               ~10ms
child dlclose + dlopen            ~50ms
state marshal across IPC          ~20ms
next frame                        ~16ms
─────────────────────────────────────────
total                           ~181ms  (same as structural, +10ms IPC tax)
```

All three targets meet the qualitative "Figma feel" bar.

---

## 4. Phase 9 — g++ Compile Acceleration

### 4.1 Intent

Attack the compile step. No architectural risk — every sub-phase is mechanical and independently testable. Benefits every HMR edit (both tiers), every library (future Phase 10 backends included), every project.

### 4.2 Design

Five orthogonal optimizations that stack:

#### 9a. ccache wrapping (~0.5 day)

- Wrap every `system_command("g++")` and `system_command("clang++")` call in `ccache <compiler>` when ccache is available.
- Detection: check `which ccache` at worker startup, set a global `USE_CCACHE: bool`.
- Cache dir: `$CCACHE_DIR` if set, else default `~/.ccache`.
- Fallback: if ccache binary missing, silently skip.
- Key design detail: ccache keys on **preprocessed source** + flags, so it catches partial hits that Phase 3's content-hash `.so` cache misses. Example: user changed a comment — Phase 3 cache misses (source hash changed), ccache hits (preprocessed output is identical).
- **Files**: `worker/src/compiler/stages/compile_core.rs`, `compile_gui.rs`, `compile_runner.rs` — wrap the command-building closures.
- **Test**: integration test spawns a compile twice with identical inputs, asserts second is <50ms.

#### 9b. Incremental `.o` caching with link-only reuse (~1-2 days)

Today's compile: `g++ source.cpp -shared -o lib.so` — one step.

Split into two:
```
g++ -c source.cpp -o source.o     # compile (~250ms cold)
g++ -shared source.o -o lib.so    # link (~30ms)
```

Cache the `.o` file by `(content_hash, flags_hash, headers_hash)` — same key structure as today's `.so` cache. On cache hit, skip the compile step entirely, just run the link (30ms instead of 280ms).

Works per module:
- User edits `gui.cpp` only.
- `core.o` cache hit → no recompile.
- `shared.h` unchanged → headers_hash unchanged for both → `core.o` hit is valid.
- `gui.o` cache miss → recompile (~250ms).
- Link `libcore.so` from cached `core.o` (~30ms), link `libgui.so` from fresh `gui.o` (~30ms).

Wall-clock savings: ~220ms on any edit that doesn't touch all modules.

- **Files**: `worker/src/hmr/incremental_cache.rs` (extend cache key + add `.o` slot), `worker/src/compiler/stages/compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`.
- **Risk**: `.o` files are position-dependent so the cache has to key on the full flag set including `-fPIC`. Already handled by `flags_hash`.
- **Test**: unit tests for cache key collision, integration test measuring wall-clock diff vs baseline.

#### 9c. Precompiled headers (PCH) (~2 days)

Library headers are massive. `<SDL2/SDL.h>` expands to ~20k lines of C/C++. `<GLFW/glfw3.h>` is ~8k. Parsing them every compile is the single biggest cost in the compile step.

Generate a `.gch` file per project at split time:

```
g++ -x c++-header -std=c++17 -shared -fPIC $COMMON_FLAGS project_pch.h -o project_pch.h.gch
```

Where `project_pch.h` is auto-generated from the biggest non-stdlib `#include` in the user source (Phase 4.5's validator already extracts this list).

On subsequent compiles:
```
g++ -include-pch=project_pch.h.gch -c source.cpp ...
```

First compile per project: no PCH yet → cold compile (~300ms) + PCH gen (~500ms overhead).
Second compile: PCH ready → compile skips header parse → ~100ms per module.

Generic approach — no library catalog. The PCH content is derived from the user's source.

- **Files**: `worker/src/compiler/stages/pch.rs` (new), `worker/src/compiler/stages/ai_utils.rs` (PCH is generated during split, not compile).
- **Edge case**: PCH must match every compile's flags exactly. If flags drift (e.g. `-O0` → `-O2`), regenerate PCH. Cache keyed on flag hash.
- **Edge case**: PCH must be compatible with the source file's std version (`c++17` PCH won't work for `c++20` source). Already handled by flag hashing.
- **Test**: integration test with SDL2 project, measure cold vs warm compile time.

#### 9d. Parallel compile of core + gui + runner (~1 day)

`core.cpp`, `gui.cpp`, and `host_runner.cpp` are independent once `shared.h` is on disk. Today's handler runs them serially:

```rust
let core_lib_path = compile_core(...).await?;
let gui_lib_path = compile_gui(...).await?;
let runner_bin = compile_runner(...).await?;
```

Change to parallel via `tokio::join!`:

```rust
let (core_result, gui_result, runner_result) = tokio::join!(
    compile_core(...),
    compile_gui(...),
    compile_runner(...),
);
let core_lib_path = core_result?;
let gui_lib_path = gui_result?;
let runner_bin = runner_result?;
```

Wall-clock on multicore: ~300ms × 3 → ~300ms + small overhead. With `.o` caching (9b), it's ~80ms for the single changed module.

- **Files**: `worker/src/compiler/handler.rs` — only the call site.
- **Risk**: the three compiles share disk I/O (writing source files, reading headers). Contention is minor for 3 jobs but worth measuring.
- **Risk**: error reporting becomes interleaved. Serialize the error messages per-module so the user gets clean diagnostics per file.
- **Test**: benchmark harness measures wall-clock improvement.

#### 9e. Content-addressable `.so` cache hit rate audit (~0.5 day)

Phase 3 already has a `.so`-level cache. Currently hit rate is unclear because it's not instrumented. Add a counter that logs hit/miss per compile. If hit rate is <50% for incremental edits, there's a bug in the cache key derivation.

- **Files**: `worker/src/hmr/incremental_cache.rs` (add counter), log on every compile.
- **Action item**: if hit rate is low, debug — likely a flag ordering issue in the key.

#### 9f. Benchmark harness (~1 day)

End-to-end latency tests:
```
benchmarks/hmr_latency.rs
  bench_value_edit_sdl2()     # measure Phase 5 speculative hit path
  bench_structural_edit_sdl2() # measure Tier 2 diff-patch path
  bench_cold_compile()         # first compile of session
```

Runs against a real compile chain. Saves a CSV. Tracked over time so we can detect regressions.

- **Files**: `benchmarks/hmr_latency.rs` (new), wired into `cargo bench`.
- **Acceptance**: value-edit p50 must drop by ≥400ms after 9a-9d land.

### 4.3 Files touched

**New**: `worker/src/compiler/stages/pch.rs`, `benchmarks/hmr_latency.rs`.
**Modified**: `compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`, `handler.rs`, `hmr/incremental_cache.rs`, `ai_utils.rs` (PCH generation in split stage).

### 4.4 Risks

- **ccache not installed in deployment env**: handled by fallback.
- **PCH flag drift bugs**: if PCH keyed incorrectly, compile errors look spooky. Add aggressive logging so the user sees "PCH skipped: flag mismatch".
- **Parallel compile race on shared.h**: `shared.h` is written ONCE before the parallel block. Parallel compiles only read.
- **ccache cross-project pollution**: each project has its own tempdir, and source paths are absolute — ccache key is unique per project.

### 4.5 Success criteria

- Cold structural-edit compile: ~600ms → ≤150ms (measured by benchmark)
- Warm incremental (1 module changed, others cached): ≤100ms (measured by benchmark)
- No regression on SDL2 build correctness (Phase 7 corpus still green in CI)
- ccache hit rate >70% after warmup

---

## 5. Phase 10 — Path A: Library-Aware Runner

### 5.1 Intent

Extract the current SDL2-specific window/event/frame code in `runner_bin.rs` into a `WindowBackend` trait. Implement the trait for GLFW, raylib, sokol, and SFML. Runtime picks the backend based on the manifest's detected framework.

Preserves all the existing infrastructure:
- Xvfb + GStreamer video capture (still captures the runner's X11 window)
- In-process dlopen HMR (no IPC overhead)
- State bridge, crash isolation, hot-swap coordinator, managed adapter protocol

Only the "create window, pump events, present frames" slice changes.

### 5.2 Design

#### 10a. Trait extraction (~1-2 days)

```rust
// worker/src/runtime/window_backend.rs (new)

use crate::runtime::legacy_module_state::AppState;

/// Opaque handle to the backend's window. Backends may wrap it in
/// whatever they need (SDL_Window*, GLFWwindow*, sf::RenderWindow, etc.)
pub struct WindowHandle {
    pub raw_ptr: *mut core::ffi::c_void,
    pub width: u32,
    pub height: u32,
}
// Send + Sync bounds asserted via backend implementations — these are
// raw pointers owned exclusively by the runner's main thread.

/// Per-frame event that backends normalise into a common vocabulary.
#[derive(Debug, Clone)]
pub enum BackendEvent {
    Quit,
    KeyDown { keycode: u32, scancode: u32, modifiers: u32 },
    KeyUp { keycode: u32, scancode: u32, modifiers: u32 },
    MouseMove { x: i32, y: i32 },
    MouseDown { button: u32, x: i32, y: i32 },
    MouseUp { button: u32, x: i32, y: i32 },
    MouseWheel { dx: f32, dy: f32 },
    Resize { width: u32, height: u32 },
    TextInput { text: String },
    /// Catch-all for backend-specific events that user code dlsym'd.
    /// The `raw_payload` is forwarded verbatim to the module via
    /// `core_on_event` — backends that don't understand a given event
    /// still forward it via this variant.
    Raw { kind: u32, payload: Vec<u8> },
}

/// Backend trait. Each implementation owns the library's init/pump/present
/// lifecycle and exposes a uniform interface to runner_bin's event loop.
pub trait WindowBackend: Send {
    /// Human-readable backend name (e.g. "SDL2", "GLFW", "raylib").
    fn name(&self) -> &'static str;

    /// Library init. Called once before any windows are created. Blocks
    /// until the library is ready. Returns an error if the library is
    /// missing or the init failed — runner_bin bails to Path C fallback
    /// in that case.
    fn init(&mut self) -> anyhow::Result<()>;

    /// Create the main window. Only called once per backend — HMR
    /// doesn't recreate windows, only reloads modules into the existing
    /// window's context.
    fn create_window(
        &mut self,
        title: &str,
        width: u32,
        height: u32,
        flags: WindowFlags,
    ) -> anyhow::Result<WindowHandle>;

    /// Pump events. Called once per frame. Returns up to N events since
    /// the last call. Returning an empty Vec is normal.
    fn poll_events(&mut self, out: &mut Vec<BackendEvent>);

    /// Begin frame. Backends that need a begin/end frame pair (most GL
    /// backends) do their setup here.
    fn begin_frame(&mut self, handle: &WindowHandle);

    /// End frame. Present / swap buffers. Called after user module's
    /// `gui_on_render` callback returns.
    fn end_frame(&mut self, handle: &WindowHandle);

    /// Cleanup. Called on runner exit, NOT on module reload — the
    /// window persists across reloads.
    fn shutdown(&mut self);
}

/// Window creation flags — mostly a passthrough from the manifest.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowFlags {
    pub resizable: bool,
    pub fullscreen: bool,
    pub vsync: bool,
    pub opengl: bool,
    pub opengl_version_major: u8,
    pub opengl_version_minor: u8,
}
```

Extract current SDL2 code from `runner_bin.rs` into `SDL2Backend` struct implementing this trait. Zero behavioral change — all existing SDL2 HMR must keep working. The trait dispatch is zero-cost (single vtable indirection per frame, negligible).

- **Files**: `worker/src/runtime/window_backend.rs` (new — trait), `worker/src/runtime/backends/sdl2_backend.rs` (new — extracted SDL2 code), `worker/src/runtime/runner_bin.rs` (refactor to use trait object).
- **Risk**: the current SDL2 code is intertwined with the GStreamer capture path. Need to isolate the window handle exposure (for capture) from the event/frame logic.

#### 10b. GLFW backend (~1 day)

```rust
// worker/src/runtime/backends/glfw_backend.rs

use crate::runtime::window_backend::*;

pub struct GLFWBackend {
    window: Option<*mut glfw_sys::GLFWwindow>,
}

impl WindowBackend for GLFWBackend {
    fn name(&self) -> &'static str { "GLFW" }

    fn init(&mut self) -> anyhow::Result<()> {
        unsafe {
            if glfw_sys::glfwInit() == 0 {
                anyhow::bail!("glfwInit() failed");
            }
        }
        Ok(())
    }

    fn create_window(&mut self, title: &str, w: u32, h: u32, flags: WindowFlags) -> anyhow::Result<WindowHandle> {
        unsafe {
            if flags.opengl {
                glfw_sys::glfwWindowHint(glfw_sys::GLFW_CONTEXT_VERSION_MAJOR, flags.opengl_version_major as i32);
                glfw_sys::glfwWindowHint(glfw_sys::GLFW_CONTEXT_VERSION_MINOR, flags.opengl_version_minor as i32);
            }
            let c_title = std::ffi::CString::new(title)?;
            let win = glfw_sys::glfwCreateWindow(w as i32, h as i32, c_title.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
            if win.is_null() {
                anyhow::bail!("glfwCreateWindow returned null");
            }
            glfw_sys::glfwMakeContextCurrent(win);
            if flags.vsync { glfw_sys::glfwSwapInterval(1); }
            self.window = Some(win);
            Ok(WindowHandle { raw_ptr: win as *mut _, width: w, height: h })
        }
    }

    // ... poll_events, begin_frame, end_frame, shutdown ...
}
```

Each `BackendEvent::*` maps to GLFW callbacks. GLFW uses a callback-based event API so the backend stores events in a thread-local Vec during poll_events.

- **Files**: `worker/src/runtime/backends/glfw_backend.rs` (new).
- **Dependency**: add `glfw-sys` or equivalent to Cargo.toml.
- **Test**: `backends/tests/glfw_window_smoke.rs` — create window, pump events, destroy.

#### 10c. raylib backend (~1 day)

raylib is higher-level than SDL/GLFW — it owns the event loop via `WindowShouldClose()` + `BeginDrawing()` / `EndDrawing()`. Adapter pattern:

- `init()` → `InitWindow(width, height, title)` (but we don't know dimensions yet)
- `create_window()` → actually creates the window (raylib couples init and create). Store title/size until then.
- `poll_events()` → drain raylib's input state via `IsKeyPressed`/`GetMouseDelta`/etc. into BackendEvents.
- `begin_frame()` → `BeginDrawing()`, `ClearBackground(BLACK)`.
- `end_frame()` → `EndDrawing()`.
- `shutdown()` → `CloseWindow()`.

raylib doesn't expose X11 window handles directly, but it uses GLFW internally on Linux and the underlying window is accessible via `GetWindowHandle()` → cast to `GLFWwindow*` → `glfwGetX11Window()`. Needed for GStreamer capture.

- **Files**: `worker/src/runtime/backends/raylib_backend.rs`.
- **Dependency**: raylib-sys FFI bindings. Or link dynamically via dlopen.

#### 10d. sokol backend (~1 day)

sokol_app.h is header-only and uses an inversion-of-control callback pattern:
```c
sapp_desc d = { .init_cb = init_fn, .frame_cb = frame_fn, ... };
sapp_run(&d);
```

`sapp_run` NEVER RETURNS — it takes over the main thread. That's incompatible with our trait design where `end_frame()` returns to the caller.

Workaround: run sokol on a dedicated thread, communicate via channels:
- Main thread calls `backend.poll_events()` → pops events from the channel the sokol thread wrote to.
- Main thread calls `backend.begin_frame()` → sends a "begin" message, waits for ack.
- The sokol_app.h frame_cb callback runs user module's gui_on_render between begin/end messages.

Alternative: build sokol_app with a custom main() that drives frames manually instead of letting sokol run the loop. Complex but possible.

- **Files**: `worker/src/runtime/backends/sokol_backend.rs`.
- **Tricky but tractable**.

#### 10e. SFML backend (~1 day)

SFML has a clean C++ class API. sf::RenderWindow exposes `pollEvent`, `clear`, `draw`, `display`, `close`. Backend wraps it.

- **Files**: `worker/src/runtime/backends/sfml_backend.rs`.
- **Dependency**: sfml-sys FFI or link libsfml directly.

#### 10f. Manifest-driven backend selection (~0.5 day)

At runner startup, read the manifest from `.synthi_split_meta.json::compile_manifest`:

```rust
fn select_backend(manifest: Option<&CompileManifest>) -> Box<dyn WindowBackend> {
    let Some(m) = manifest else {
        // Pre-Phase-3 sidecar or no manifest → assume SDL2 (backward compat)
        return Box::new(SDL2Backend::new());
    };
    // Substring scan of gui_link_flags to identify the library
    let flags: Vec<String> = m.gui_link_flags.iter().map(|s| s.to_lowercase()).collect();
    for f in &flags {
        if f.contains("sdl2") || f.contains("sdl") { return Box::new(SDL2Backend::new()); }
        if f.contains("glfw") { return Box::new(GLFWBackend::new()); }
        if f.contains("raylib") { return Box::new(RaylibBackend::new()); }
        if f.contains("sfml") { return Box::new(SFMLBackend::new()); }
    }
    // sokol is header-only — no link flag. Detect via arch cache language
    // string or notes.
    // ...
    // Unknown library → Path C fallback (Phase 12)
    Box::new(FallbackBackend::new(manifest))
}
```

Generic by construction — adds libraries without touching existing backends.

- **Files**: `worker/src/runtime/runner_bin.rs` (call site), `worker/src/runtime/window_backend.rs` (selector function).

### 5.3 Files touched

**New**:
- `worker/src/runtime/window_backend.rs`
- `worker/src/runtime/backends/mod.rs`
- `worker/src/runtime/backends/sdl2_backend.rs`
- `worker/src/runtime/backends/glfw_backend.rs`
- `worker/src/runtime/backends/raylib_backend.rs`
- `worker/src/runtime/backends/sokol_backend.rs`
- `worker/src/runtime/backends/sfml_backend.rs`
- `worker/src/runtime/backends/fallback_backend.rs` (stub that errors out — Path C replaces it in Phase 12)

**Modified**:
- `worker/src/runtime/runner_bin.rs` — replace hardcoded SDL2 with trait dispatch
- `worker/Cargo.toml` — new FFI dependencies (glfw-sys, raylib-sys, sfml-sys, sokol)
- `.github/workflows/universal-split-test.yml` — extend corpus CI to exercise each backend at runtime

### 5.4 Risks

- **Backend-specific quirks**: each library has its own init order assumptions (e.g. SDL2 needs SDL_INIT_VIDEO BEFORE window creation; GLFW wants version hints BEFORE create; raylib couples init and create). Documented per-backend.
- **Event normalization loss**: some events don't map cleanly across libraries (e.g. SDL2's SDL_TEXTEDITING vs GLFW's char callback). Use `BackendEvent::Raw` for lossless forwarding.
- **GStreamer capture**: needs a window handle exposed in a known format. All backends must expose the X11 window via `handle.raw_ptr`. Verify per-backend.
- **Dlopen conflicts**: if two backends are linked statically, their symbol tables can conflict. Use `dlopen` with `RTLD_LOCAL` to isolate.
- **Binary size bloat**: linking 5 libraries statically bloats `runner_bin`. Mitigation: dlopen each backend library on demand. Only the selected backend gets loaded at runtime.

### 5.5 Success criteria

- Phase 7 corpus runs end-to-end (not just build-time) for SDL2, GLFW, raylib, sokol, SFML
- HMR latency for each backend within 10% of SDL2 baseline (same fast path, same floor)
- No regression on existing SDL2 projects
- Dynamic dlopen load: only the selected backend library gets loaded per runner process

---

## 6. Phase 11 — Binary Patching for Value Edits

### 6.1 Intent

Skip g++ entirely for value-only edits. Patch the compiled `.so` bytes in place, instruct the runner to pick up the new value on the next frame. Target: ≤25ms from save to rendered frame.

This is the "wow factor" phase. ~60% of real-world edits are value tweaks (colors, sizes, speeds, counts, strings). Making them feel instant transforms the IDE experience from "fast" to "magical".

### 6.2 Design

#### 11a. DWARF-driven literal location (~3-4 days)

The `.so` files are compiled with `-gdwarf-4` (already in the manifest's `common_flags`). DWARF debug info maps source lines to binary offsets. Use the `gimli` crate (rust DWARF parser, already widely used, well-maintained).

```rust
// worker/src/hmr/binary_patch/dwarf_lookup.rs

pub struct LiteralLocation {
    pub so_path: PathBuf,
    pub rodata_offset: u64,  // byte offset within .rodata section
    pub size: usize,          // size of the literal in bytes
    pub original_bytes: Vec<u8>,
    pub symbol_name: Option<String>,  // for logging/diagnostics
}

pub fn locate_literal_at(
    so_path: &Path,
    source_line: u32,
    source_column: u32,
    value_text: &str,  // e.g. "0xFF0000"
) -> Result<LiteralLocation, PatchLookupError> {
    // 1. Parse DWARF .debug_line to find the instruction address at
    //    (file, line, column).
    // 2. Parse .debug_info to find DW_TAG_variable / DW_TAG_formal_parameter
    //    entries whose DW_AT_decl_line matches.
    // 3. For each candidate, check DW_AT_location — if it's a
    //    DW_OP_addr pointing into .rodata, we've found the literal.
    // 4. Read the bytes at that offset and verify they match value_text.
    // 5. Return LiteralLocation.
}
```

Edge cases:
- **Constant folded into an immediate instruction**: the value is encoded as part of an `imm32` in a `mov` instruction, not in `.rodata`. Requires patching the instruction bytes instead. Add `InstructionOperand` variant to `LiteralLocation`.
- **Float literals**: often loaded via `movss`/`movsd` from `.rodata`. Straightforward — same path as integer literals in rodata.
- **String literals**: live in `.rodata` as null-terminated C strings. Can patch if new string is ≤ old string length (leave null terminator at end). Longer strings → fall back to compile.
- **Compiler optimizations**: `-O0` keeps literals in rodata. `-O2` may fold them into immediates. The manifest's common_flags includes `-g -O0` for HMR builds, so we're in the friendly case.

- **Files**: `worker/src/hmr/binary_patch/dwarf_lookup.rs`, `worker/src/hmr/binary_patch/mod.rs`.
- **Dependency**: `gimli = "0.28"` in Cargo.toml.
- **Test**: compile a tiny test program with known literals, DWARF-index them, verify offsets match.

#### 11b. Layout stability check (~1-2 days)

Before patching, verify the new value is layout-compatible with the old:

```rust
pub enum LayoutCheck {
    Ok,
    SizeChanged { old: usize, new: usize },
    TypeChanged { old: String, new: String },
    StringTooLong { old_cap: usize, new_len: usize },
    UnsafeForPatching(String),
}

pub fn check_layout_stability(
    old_loc: &LiteralLocation,
    new_value: &NewLiteralValue,
) -> LayoutCheck {
    match new_value {
        NewLiteralValue::Int(n) => {
            // Fits in the same number of bytes? Signedness match?
            if n.unsigned_abs().leading_zeros() < old_loc.size as u32 * 8 {
                LayoutCheck::Ok
            } else {
                LayoutCheck::SizeChanged { old: old_loc.size, new: required_size(n) }
            }
        }
        NewLiteralValue::Float(f) => {
            // Same IEEE 754 size (f32 vs f64)? Requires source type info.
            LayoutCheck::Ok  // simplification
        }
        NewLiteralValue::String(s) => {
            if s.len() + 1 > old_loc.size {
                LayoutCheck::StringTooLong { old_cap: old_loc.size, new_len: s.len() + 1 }
            } else {
                LayoutCheck::Ok
            }
        }
    }
}
```

Any result other than `Ok` → fall back to compile path. No attempt to "force" a patch that might corrupt the binary.

- **Files**: `worker/src/hmr/binary_patch/layout.rs`.
- **Philosophy**: aggressively conservative. False negatives (fall back when we could have patched) cost 600ms. False positives (patch when we shouldn't) corrupt the runner process. Prefer the former.

#### 11c. Runtime memory patching via helper library (~2-3 days)

The runner process already has the `.so` loaded via `dlopen`. Patching the file on disk doesn't affect the loaded copy (which is usually mapped `MAP_PRIVATE`). We need to patch the **runner's in-memory** copy.

Architecture: a small helper library `libsynthi_patcher.so` that the runner dlopens at startup alongside its own modules. Exposes:

```c
// libsynthi_patcher.h
#ifndef SYNTHI_PATCHER_H
#define SYNTHI_PATCHER_H

#ifdef __cplusplus
extern "C" {
#endif

/// Patch `size` bytes at `addr` with `new_bytes`. The caller (Rust
/// worker) has already validated that this is layout-stable.
/// Returns 0 on success, negative errno on failure.
int synthi_patch_bytes(void* addr, const void* new_bytes, size_t size);

/// Invalidate instruction cache lines in the range [addr, addr+size).
/// Required on ARM; x86 is coherent by default but future-proof.
int synthi_invalidate_icache(void* addr, size_t size);

#ifdef __cplusplus
}
#endif
#endif
```

Implementation uses `mprotect` to make the page writable, `memcpy`, restore protection, then `__builtin___clear_cache`.

The Rust worker sends a "patch" command to the runner via the existing stdin HMR protocol:
```
patch <so_name> <rodata_offset> <bytes_hex>
```

Runner receives, resolves `<so_name>` via its dlopen handle table, computes the runtime address (`dlsym(handle, "some_symbol")` gives symbol addresses; `.rodata` offset is relative to the `.so`'s base load address obtained via `dlinfo(RTLD_DI_LINKMAP, ...)` + `l_addr`).

- **Files**: `worker/src/runtime/patcher/libsynthi_patcher.c` (new — small C lib), `worker/src/runtime/patcher/build.rs` (compile during cargo build), runner_bin.rs (handle `patch` command).
- **Risk**: `mprotect` requires page-aligned addresses. Use `PAGE_SIZE` from sysconf, round down.
- **Risk**: concurrent reads of `.rodata` by user code during the patch. Solved by the Tier 0 Frame-Sync coherency step (§11d).

#### 11d. Frame-sync coherency (~1 day)

User code reads the patched value on the next frame. The runner's event loop synchronizes naturally: `gui_on_render` is called once per frame, so patching between frames is safe. The runner acknowledges the patch and holds the next frame by ~1ms to ensure the write is visible.

Protocol:
```
worker → runner:  patch libgui.so 0x12340 ff00ff00
runner → worker:  ack patch 0  (0 = success, -N = errno)
                  (next frame renders with new value)
```

- **Files**: runner_bin.rs protocol handler, ai_utils.rs worker dispatch.

#### 11e. Tier 0 integration (~1 day)

New tier in handler.rs above the existing Tier 1/2/3:

```
Tier 0 (NEW): classify_edit → is_value_only? → DWARF lookup → layout check → binary patch
                                              → success? → return Ok (done in ~25ms)
                                              → failure? → fall through to Tier 1
Tier 1: source-level text patch + compile (current ~670ms path)
Tier 2: AI diff_patch + compile (~870ms path)
Tier 3: full AI re-split + compile (~3s path)
```

Tier 0 is opt-in via a feature flag in Phase 1 of rollout, then default-on after metrics prove it's reliable.

- **Files**: handler.rs Tier 0 block, just above the existing Tier 1 value-fallback.
- **Fallback**: ANY failure in Tier 0 (DWARF parse fails, layout check fails, patch IPC errors, etc.) silently falls through. The user never sees a Tier 0 error — they just get Tier 1's ~670ms path. No regression on failure.

#### 11f. Tests (~1-2 days)

- **Unit**: DWARF literal lookup on pre-built test `.so` files with known literals. Assert offset correctness.
- **Unit**: layout stability checks for each literal kind (int within range, int out of range, string fit, string overflow, type size change).
- **Integration**: compile a small SDL2 project, force a value edit, assert the patch hits the right bytes by diffing old vs new `.so`.
- **Negative**: edit that changes a type size, verify fallback fires and the final result is correct.
- **Benchmark**: measure end-to-end value-edit latency with Tier 0 vs Tier 1. Must be ≤30ms p50.

### 6.3 Files touched

**New**:
- `worker/src/hmr/binary_patch/mod.rs`
- `worker/src/hmr/binary_patch/dwarf_lookup.rs`
- `worker/src/hmr/binary_patch/layout.rs`
- `worker/src/hmr/binary_patch/patch_dispatch.rs`
- `worker/src/runtime/patcher/libsynthi_patcher.c`
- `worker/tests/phase11_binary_patch.rs`

**Modified**:
- `worker/src/compiler/handler.rs` (new Tier 0)
- `worker/src/runtime/runner_bin.rs` (patch command handler)
- `worker/Cargo.toml` (gimli dependency)

### 6.4 Risks

- **DWARF variance**: GCC and clang emit slightly different DWARF. Test both. Use gimli's high-level API that handles both.
- **Compiler optimizations break literal locatability**: if the user compiles with `-O2`, literals may be folded into instructions. Detect and fall back.
- **Architecture portability**: x86_64 first. ARM64 needs `dsb ish; isb` after the write. Well-documented.
- **Security**: making pages writable is a reduction in process hardening. Only used during patch, immediately restored. Patch is only called with validated inputs.
- **State corruption**: if the patched value is WRONG (wrong offset, wrong bytes), the runner crashes. Mitigation: Tier 0 includes an integrity check — read the old bytes at the patch location, verify they match the expected old value before patching. If mismatch → fall back.

### 6.5 Success criteria

- Value-edit HMR p50 ≤25ms (measured by Phase 9 benchmark harness)
- Value-edit HMR p99 ≤60ms
- Fallback to Tier 1 on layout change preserves correctness
- Zero crashes in 1000-edit fuzz run
- Tier 0 hit rate on value-only edits ≥80% (the 20% miss are string-length changes, enum-to-new-value, etc.)

---

## 7. Phase 12 — Path C: Supervisor + Child Process

### 7.1 Intent

For zero-day libraries (Qt, JUCE, random user-authored frameworks) AND true BYOR projects where the user wrote their own `host_runner.cpp`: spawn the AI-synthesized `host_runner_<timestamp>` binary as a child process inside Xvfb, capture its window generically, communicate HMR commands via IPC.

This is the safety net. Most projects use Phase 10's Path A. Phase 12 catches the long tail.

### 7.2 Design

#### 12a. Process architecture (~2 days)

```
┌─────────────────────────────────────┐
│ runner_bin (supervisor)             │
│  ├─ spawns Xvfb on :100             │
│  ├─ spawns host_runner_<ts>         │◄─────┐
│  │    (child, DISPLAY=:100)         │      │ IPC: Unix socket
│  ├─ GStreamer captures :100         │      │      /tmp/synthi_hmr.sock
│  └─ HMR protocol ───────────────────┘      │
└─────────────────────────────────────┘      │
                ▲                            │
                │ stdin "reload X Y"         │
                │                            ▼
         Rust worker                  child process
                                      (user's code)
```

- Supervisor allocates a fresh X display (via `Xvfb-run` or direct `Xvfb :NNN -screen 0 1280x720x24`).
- Spawns `host_runner_<timestamp>` with `DISPLAY=:NNN` and `SYNTHI_HMR_SOCKET=/tmp/synthi_hmr_<session>.sock`.
- GStreamer capture uses `ximagesrc display-name=:NNN` — works for any X11 client, doesn't care whether it's SDL/GLFW/Qt.
- Child process discovers the HMR socket via env var, connects, waits for commands.

- **Files**: `worker/src/runtime/path_c/supervisor.rs`, `worker/src/runtime/path_c/xvfb.rs`.

#### 12b. HMR protocol over IPC (~2-3 days)

Use `serde_json` over Unix socket — same shape as the existing stdin protocol, just transport is different.

```rust
// Supervisor → child
enum HmrCommand {
    Load { module_name: String, so_path: String },
    Unload { module_name: String },
    Reload { module_name: String, so_path: String },
    PatchBytes { module_name: String, offset: u64, bytes: Vec<u8> },  // Phase 11 integration
    Shutdown,
}

// Child → supervisor
enum HmrResponse {
    Ack { command_id: u64 },
    Error { command_id: u64, code: i32, message: String },
    StateSize { bytes: u64 },  // for state marshaling reports
}
```

Child-side runtime (`libsynthi_hmr_runtime.a` — a static lib the user's runner links against):

```c
// synthi_hmr_runtime.h
#ifndef SYNTHI_HMR_RUNTIME_H
#define SYNTHI_HMR_RUNTIME_H

/// Call from main() in user's host_runner.cpp ONCE at startup.
/// Connects to SYNTHI_HMR_SOCKET and spawns a background thread that
/// receives HMR commands. Returns 0 on success, negative errno on
/// failure. On success, subsequent calls to synthi_hmr_should_reload()
/// return true when a module reload has been requested.
int synthi_hmr_init(void);

/// Main-thread hook called at the top of every frame. Checks the
/// pending-reload flag; if set, performs dlclose/dlopen on the
/// affected module via the in-process state bridge and resets the
/// flag. Returns 0 on success.
int synthi_hmr_on_frame(void);

/// Cleanup on exit.
void synthi_hmr_shutdown(void);

#endif
```

AI-generated `host_runner.cpp` calls `synthi_hmr_init()` at the top of `main()` and `synthi_hmr_on_frame()` at the top of each event-loop iteration. The universal split prompt (Phase 1) gets updated to emit these calls.

- **Files**: `worker/src/runtime/path_c/hmr_protocol.rs`, `worker/src/runtime/patcher/libsynthi_hmr_runtime.c` (new C lib the user's runner links), `ai-backend/ai-engine/llm/prompts.py` (UNIVERSAL_SPLIT_PROMPT host-runner instructions append the init/on_frame calls).

#### 12c. BYOR compatibility (~1-2 days)

BYOR users (detected via `// SYNTHI_USER_RUNNER` sentinel — already implemented in Phase 4) just link against `libsynthi_hmr_runtime.a` and call `synthi_hmr_init()` at startup. The library handles the protocol transparently.

If a BYOR user forgets to call init, their project runs but HMR doesn't work — they see edits on disk but no live update. Supervisor detects the missing handshake after a 2s timeout and surfaces a diagnostic: "Your host_runner.cpp didn't call synthi_hmr_init() — HMR is disabled."

- **Files**: `worker/src/runtime/path_c/supervisor.rs` (handshake timeout), `synthi/src/components/compile/CompileErrorCard.jsx` (new error kind `BYOR_NO_HMR_INIT`).

#### 12d. Fallback from Path A (~1 day)

At backend selection time (Phase 10 §10f), if no Path A backend matches:

```rust
fn select_backend(manifest: Option<&CompileManifest>) -> Box<dyn WindowBackend> {
    // Try Path A backends first
    if let Some(path_a) = try_path_a_match(manifest) {
        return path_a;
    }
    // Fall through to Path C
    eprintln!("[Runner] No Path A backend matched — using Path C supervisor mode");
    Box::new(PathCBackend::new(manifest))
}
```

`PathCBackend` is a special WindowBackend implementation whose methods are stubs — it delegates window handling to the child process entirely. The supervisor forwards events back to the child via IPC.

- **Files**: `worker/src/runtime/backends/path_c_backend.rs` (new).

#### 12e. Video stream latency audit (~1 day)

Xvfb `ximagesrc` capture has slightly higher latency than direct window-handle capture (~20-40ms added vs Path A). Measure and characterize:

- **Target**: ≤50ms added p50 over Path A
- **Tuning**: pixel format (BGRx), use-damage for incremental capture, buffer pool sizing
- **Fallback**: if latency exceeds 100ms, investigate DRI3/hardware acceleration

- **Files**: `worker/src/runtime/path_c/video_pipeline.rs`, benchmark harness in Phase 9f extended.

### 7.3 Files touched

**New**:
- `worker/src/runtime/path_c/mod.rs`
- `worker/src/runtime/path_c/supervisor.rs`
- `worker/src/runtime/path_c/xvfb.rs`
- `worker/src/runtime/path_c/hmr_protocol.rs`
- `worker/src/runtime/path_c/video_pipeline.rs`
- `worker/src/runtime/backends/path_c_backend.rs`
- `worker/src/runtime/patcher/libsynthi_hmr_runtime.c`
- `worker/tests/phase12_path_c.rs`

**Modified**:
- `worker/src/runtime/runner_bin.rs` (fallback to PathCBackend)
- `ai-backend/ai-engine/llm/prompts.py` (host_runner init/on_frame generation)

### 7.4 Risks

- **Xvfb overhead**: spawning Xvfb per session adds ~200ms startup cost. Acceptable for session init; not per-reload.
- **ximagesrc latency**: ~20-40ms per frame capture vs direct window handle. Measure and tune.
- **IPC HMR latency**: ~5-10ms per reload vs in-process ~0.5ms. Acceptable (the user-perceived total is still sub-200ms).
- **Socket cleanup**: Unix sockets need cleanup on crash. Use `tmpfile::NamedTempFile` or abstract sockets.
- **Child process crash**: detect via pidfd/waitpid, log the crash, surface to frontend via the existing rejection path.
- **Linking** `libsynthi_hmr_runtime.a`: manifest must automatically add `-lsynthi_hmr_runtime` to runner_link_flags for Path C projects. Update Phase 3 manifest generation.

### 7.5 Success criteria

- Qt and JUCE projects run end-to-end (Phase 7 corpus regression includes these as `expect_path_c: true`)
- Zero-day library with nothing in Phase 10 → automatic Path C fallback, no user intervention
- BYOR projects work: user writes `host_runner.cpp` with sentinel + calls `synthi_hmr_init`, HMR edits round-trip correctly
- Path C HMR latency ≤280ms p50 (Path A target + 100ms IPC tax)

---

## 8. Files Touched — Full List

### New files (~30)

**Worker (Rust)**:
```
worker/src/compiler/stages/pch.rs
worker/src/runtime/window_backend.rs
worker/src/runtime/backends/mod.rs
worker/src/runtime/backends/sdl2_backend.rs
worker/src/runtime/backends/glfw_backend.rs
worker/src/runtime/backends/raylib_backend.rs
worker/src/runtime/backends/sokol_backend.rs
worker/src/runtime/backends/sfml_backend.rs
worker/src/runtime/backends/fallback_backend.rs
worker/src/runtime/backends/path_c_backend.rs
worker/src/runtime/path_c/mod.rs
worker/src/runtime/path_c/supervisor.rs
worker/src/runtime/path_c/xvfb.rs
worker/src/runtime/path_c/hmr_protocol.rs
worker/src/runtime/path_c/video_pipeline.rs
worker/src/hmr/binary_patch/mod.rs
worker/src/hmr/binary_patch/dwarf_lookup.rs
worker/src/hmr/binary_patch/layout.rs
worker/src/hmr/binary_patch/patch_dispatch.rs
worker/src/runtime/patcher/libsynthi_patcher.c
worker/src/runtime/patcher/libsynthi_hmr_runtime.c
worker/tests/phase9_compile_optimization.rs
worker/tests/phase10_window_backends.rs
worker/tests/phase11_binary_patch.rs
worker/tests/phase12_path_c.rs
benchmarks/hmr_latency.rs
```

**Python (ai-engine)**: no new files — only `llm/prompts.py` modification for Phase 12c.

**Frontend**: no new files in this plan — frontend scaffolding from `HMR_AGNOSTIC_ULTRAPLAN.md` Phase 8 already covers manifest + error card + confidence warning. Phase 12 adds one new `REJECTION_KINDS` value (`BYOR_NO_HMR_INIT`).

### Modified files

- `worker/Cargo.toml` — 6-8 new dependencies (glfw-sys, raylib-sys, sfml-sys, sokol-app, gimli, libc, ...)
- `worker/src/runtime/runner_bin.rs` — trait dispatch refactor
- `worker/src/compiler/handler.rs` — Tier 0 block, parallel compile join
- `worker/src/compiler/stages/compile_core.rs`, `compile_gui.rs`, `compile_runner.rs` — ccache wrap, .o caching, PCH include
- `worker/src/compiler/stages/ai_utils.rs` — PCH generation hook
- `worker/src/hmr/incremental_cache.rs` — .o slot addition
- `ai-backend/ai-engine/llm/prompts.py` — host_runner init/on_frame calls
- `synthi/src/components/compile/CompileErrorCard.jsx` — new rejection kind
- `.github/workflows/universal-split-test.yml` — corpus runtime coverage

---

## 9. Sequencing & Rollout

### 9.1 Recommended order

**Phase 9 first** (compile optimization). Why:
- Benefits every edit, every library, every phase after
- Zero architectural risk — each sub-phase is mechanical
- Ships wins in 3-5 days
- Baseline benchmarks in 9f are needed to validate 11 and 12

**Phase 11 second** (binary patching). Why:
- Biggest UX impact per day of effort — value edits feel instant
- Can ship behind a feature flag initially, flip on after metrics prove reliability
- Independent of runtime backend — works on Path A and Path C equally
- Two weeks of work for a "wow" moment users will notice immediately

**Phase 10 third** (Path A library backends). Why:
- Expands library coverage at runtime (build-time is already agnostic from `HMR_AGNOSTIC_ULTRAPLAN.md`)
- Ship backends one at a time: GLFW → raylib → sokol → SFML
- Each backend is ~200 LoC, independently testable
- Phase 7 corpus gains runtime coverage

**Phase 12 last** (Path C supervisor). Why:
- Most architectural risk — new process model, new IPC, new socket lifecycle
- Catches the long tail, not the common case — ship after Phases 9-11 have proven the common case is solid
- Also unlocks true BYOR, which is a niche feature compared to Path A's breadth

### 9.2 Alternative order (coverage-first)

If "must run any library" matters more than "must feel instant":

Phase 9 → 10 → 12 → 11

Deliver library coverage (Phase 10 + fallback Phase 12) before the binary-patching wow factor. Users see "works for my library" win before "is instant" win. More conservative — Phase 11 can slip without blocking coverage.

### 9.3 Feature-flag rollout

Each phase ships dark → opt-in → default-on:

- **Phase 9a-9e**: always-on (no risk). 9f is a benchmark harness, opt-in.
- **Phase 10 backends**: dark behind `SYNTHI_BACKEND_<NAME>=1` env var per backend. Flip to default after Phase 7 corpus runtime test is green for that backend.
- **Phase 11 Tier 0**: dark behind `SYNTHI_TIER_ZERO=1` env var. Opt-in per session. Default-on after 1 week of metrics showing <0.1% fallback rate and zero crashes.
- **Phase 12 Path C**: default-on as fallback for unsupported libraries (no flag needed — it's the safety net). For BYOR users, enabled via the existing BYOR toggle in Settings.

### 9.4 Estimated total timeline

```
Phase 9  (compile opt)         : 3-5 days
Phase 11 (binary patching)     : 10-14 days
Phase 10 (Path A 5 backends)   : 8-12 days
Phase 12 (Path C)              : 14 days
                               ─────────────
Total                          : 35-45 days (~7-9 weeks)
```

Can be compressed by parallel work: Phase 9 + Phase 10 backends can ship in parallel (different codepaths). Phase 11 and Phase 12 are sequential because both modify the runner's HMR protocol handler.

Aggressive single-track estimate: 5-7 weeks.
Conservative estimate with proper testing: 8-10 weeks.

---

## 10. Test Strategy

### 10.1 Unit tests

- Phase 9: PCH cache key correctness, .o cache hit/miss under flag drift
- Phase 10: per-backend window create/destroy, event normalization
- Phase 11: DWARF lookup on test fixtures, layout stability edge cases, patch dispatch dry-run
- Phase 12: IPC protocol round-trip, handshake timeout, xvfb lifecycle

### 10.2 Integration tests

- Phase 9: end-to-end compile chain with optimizations, benchmark assertions
- Phase 10: Phase 7 corpus runtime test — each corpus entry spawns a real runner and verifies an edit round-trips
- Phase 11: force-Tier-0 value edit on SDL2 SDL_Rect color, verify patched bytes
- Phase 12: force-Path-C on a Phase 7 corpus entry, verify HMR edit round-trips via supervisor

### 10.3 Benchmarks (Phase 9f, extended in 11g)

CSV-logged, checked into the repo, tracked per-commit:

```csv
phase,scenario,library,p50_ms,p95_ms,p99_ms,sample_n,commit
9,value_edit,SDL2,670,820,1100,100,abc123
10,value_edit,GLFW,680,840,1150,100,abc124
11,value_edit,SDL2,25,40,55,100,def456
...
```

Regression gate: any PR that raises p50 by >10% fails CI.

### 10.4 Fuzz / chaos

- Phase 11: 1000 random value edits, verify zero crashes and bytes-on-disk matches expected
- Phase 12: rapid child-crash-restart cycle (kill child every N frames), verify supervisor recovers

---

## 11. Risks — Cross-Cutting

| Risk | Phase | Mitigation |
|---|---|---|
| Backend library not installed in deployment env | 10 | Dynamic dlopen — library missing → Path C fallback |
| Binary patch silently corrupts runner | 11 | Integrity check before patch; Tier 0 wraps itself in `std::panic::catch_unwind` for defensive crash recovery |
| PCH flag mismatch causes mysterious compile errors | 9 | Aggressive PCH cache invalidation on any flag change; log PCH hit/miss |
| IPC latency tax pushes Path C over budget | 12 | Early measurement, xvfb tuning, optional fallback to direct-capture mode |
| Compiler DWARF variance breaks literal lookup | 11 | Test against both gcc and clang; use gimli's high-level API |
| Xvfb display leak on crash | 12 | Use `Xephyr` instead, or wrap in a cgroup for auto-cleanup |
| Tier 0 false positives crash runner | 11 | Integrity check; conservative layout checks; fuzz test |
| Runtime selection picks wrong backend | 10 | Manifest-driven — if manifest is wrong, Path A still fails loudly (not silently). Path C catches. |
| Phase 12 breaks existing SDL2 runs | 12 | Path C is off the default path for SDL2 — only kicks in when no Path A backend matches |
| g++ parallel compile contention | 9 | Limit to N=CPUs/2, measure |
| BYOR user forgets to call synthi_hmr_init | 12 | 2s handshake timeout, clear diagnostic |

---

## 12. Out of Scope

Explicitly NOT in this plan:

- **Non-C/C++ languages** — Rust, Go, Zig HMR is post-V2. Different binary patching, different DWARF shape.
- **Multi-step build systems** — Qt MOC, CMake, Meson rejected per `HMR_AGNOSTIC_ULTRAPLAN.md` Mitigation 3. Post-V2.
- **Remote runners** — HMR across network is post-V3.
- **Multi-window projects** — single window per runner. Post-V2.
- **GPU compute / CUDA** — kernels in `.so` files would need their own patch path. Post-V2.
- **Windows / macOS runners** — Phase 12 assumes X11. Wayland is tractable but unscoped. Windows and macOS need entirely different capture pipelines, post-V3.
- **Full code generation** — we only patch existing literals, not rewrite entire functions. If a change needs new logic, Tier 0 falls through to compile.
- **Real-time collaborative HMR** — multiple users hot-editing the same running project. Post-V2.

---

## 13. Success = User Quotes

The plan is successful when users say, unprompted:

- "I can't believe how fast HMR is now."
- "I tweaked that color and it just... changed. There was no save."
- "Wait, this IDE handles GLFW projects too?"
- "Why is Synthi faster than vite?"
- "I didn't realize I was using raylib until I looked at the status bar."

Any one of those quotes justifies the full 7-week investment.

---

*Plan authored after `HMR_AGNOSTIC_ULTRAPLAN.md` shipped (Phases 1-8) on branch `claude/hmr-agnostic-ultraplan`. This plan continues on a new branch (TBD) once approved.*
