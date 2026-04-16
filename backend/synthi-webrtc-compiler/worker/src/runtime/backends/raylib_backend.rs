// ============================================================
// RAYLIB BACKEND (ULTRAPLAN Lightning Phase 10c)
// ============================================================
//
// Third concrete `WindowBackend` implementation. Like GLFW, raylib
// is loaded at runtime via `libloading` so the worker binary stays
// free of a build-time raylib dependency — deployments that want
// raylib projects just install `libraylib` on the host.
//
// ─── Raylib quirks vs SDL2/GLFW ──────────────────────────────
//
// Raylib's public API is procedural and stateful: there is ONE
// implicit window owned by raylib's private globals. There's no
// handle type returned from `InitWindow`, and there's no notion
// of multiple windows. This maps OK onto the WindowBackend trait
// because the trait only needs ONE window per runner session, but
// we can't store a raw pointer to the "window" — we use a dummy
// sentinel pointer (address of a static zero byte) in WindowHandle
// so the runner's null-checks still work.
//
// ─── Method mapping ──────────────────────────────────────────
//
//   trait method          → raylib call
//   init                  → (no-op; raylib has no separate init, just
//                           InitWindow does it implicitly during
//                           create_window)
//   create_window         → InitWindow(w, h, title) + GetWindowHandle
//                           for X11 id on Linux
//   pump_events           → PollInputEvents (updates raylib's internal
//                           input state) + WindowShouldClose check
//   push_synthetic_event  → NOT SUPPORTED — raylib has no synthetic
//                           event API; returns Err like GLFW does
//   present_frame         → SwapScreenBuffer (raylib's equivalent of
//                           SDL_RenderPresent / glfwSwapBuffers)
//   destroy_window        → CloseWindow (tears down raylib globals)
//   shutdown              → drop the dlopen handle (CloseWindow already
//                           torn down internal state in destroy_window)
//
// ─── Why lazy dlopen + not a cargo crate? ───────────────────
//
// Same reasoning as glfw_backend.rs (rev3 §10b). Runtime dlopen
// keeps build-time deps clean, avoids version-locking to whatever
// a binding crate supports, and lets us swap distro sonames
// (libraylib.so.5 / libraylib.so.4 / libraylib.so) without a
// recompile.
//
// ─── On X11 window ID lookup ────────────────────────────────
//
// raylib's `GetWindowHandle()` returns `void*` whose meaning is
// platform-specific. On Linux it's the X11 `Window` value (a u64
// when cast via `Window` from Xlib) — GStreamer ximagesrc needs
// this for capture. On macOS / Windows it's something else and we
// leave `x11_window_id` as None.

#![allow(dead_code)]
// ^^ Like the other backends, this file is dead code until Phase
// 10g.2 migrates runner_bin to use the WindowBackend trait. The
// inline tests + the tests/phase10c_raylib_backend.rs integration
// tests exercise the public surface.

use crate::runtime::window_backend::{
    BackendEvent, WindowBackend, WindowFlags, WindowHandle,
};
use anyhow::{anyhow, Result};
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_int, c_void, CString};

// Raylib C API function signatures (the minimum surface we use).
// Source of truth: raylib 4.x/5.x public headers. These are stable
// across minor versions; breaking changes only arrive on major
// bumps (4.x → 5.x). We don't version-gate because the signatures
// we use haven't changed across known releases.
type RlInitWindow = unsafe extern "C" fn(width: c_int, height: c_int, title: *const c_char);
type RlCloseWindow = unsafe extern "C" fn();
type RlWindowShouldClose = unsafe extern "C" fn() -> c_int;
type RlPollInputEvents = unsafe extern "C" fn();
type RlSwapScreenBuffer = unsafe extern "C" fn();
type RlSetConfigFlags = unsafe extern "C" fn(flags: c_int);
type RlSetTargetFPS = unsafe extern "C" fn(fps: c_int);
type RlGetWindowHandle = unsafe extern "C" fn() -> *mut c_void;
type RlIsWindowReady = unsafe extern "C" fn() -> c_int;

// Raylib ConfigFlags — bit flags we OR together and pass to
// SetConfigFlags BEFORE InitWindow. These are stable across 4.x/5.x.
const FLAG_VSYNC_HINT: c_int = 0x00000040;
const FLAG_FULLSCREEN_MODE: c_int = 0x00000002;
const FLAG_WINDOW_RESIZABLE: c_int = 0x00000004;
const FLAG_MSAA_4X_HINT: c_int = 0x00000020;

/// Sentinel pointer used as WindowHandle.raw_ptr for raylib. Raylib
/// doesn't expose a window handle type — it has ONE global window
/// owned by private state — so we point at this static byte just
/// so the null-check in the runner's main loop doesn't fire.
static RAYLIB_WINDOW_SENTINEL: u8 = 0;

pub struct RaylibBackend {
    /// Held to keep libraylib mapped. Dropped during `shutdown` to
    /// release the dlopen handle.
    lib: Option<Library>,
    /// Resolved function pointers, populated during `init()`.
    rl_init_window: Option<RlInitWindow>,
    rl_close_window: Option<RlCloseWindow>,
    rl_window_should_close: Option<RlWindowShouldClose>,
    rl_poll_input_events: Option<RlPollInputEvents>,
    rl_swap_screen_buffer: Option<RlSwapScreenBuffer>,
    rl_set_config_flags: Option<RlSetConfigFlags>,
    rl_set_target_fps: Option<RlSetTargetFPS>,
    rl_get_window_handle: Option<RlGetWindowHandle>,
    rl_is_window_ready: Option<RlIsWindowReady>,
    /// Set to true once create_window has run. Raylib's "window
    /// exists" query (IsWindowReady) returns 0 before InitWindow,
    /// but we also cache locally so we don't pay an FFI call on
    /// every method entry.
    window_active: bool,
}

impl RaylibBackend {
    pub fn new() -> Self {
        Self {
            lib: None,
            rl_init_window: None,
            rl_close_window: None,
            rl_window_should_close: None,
            rl_poll_input_events: None,
            rl_swap_screen_buffer: None,
            rl_set_config_flags: None,
            rl_set_target_fps: None,
            rl_get_window_handle: None,
            rl_is_window_ready: None,
            window_active: false,
        }
    }

    /// Try to dlopen libraylib under the standard distro names.
    /// Tries newest soname first (raylib 5.x → libraylib.so.5)
    /// and falls through to the plain name last.
    fn try_load_library() -> Result<Library> {
        let candidates = [
            "libraylib.so.5",
            "libraylib.so.4.5",
            "libraylib.so.4",
            "libraylib.so",
        ];
        let mut errors = Vec::new();
        for name in &candidates {
            // SAFETY: libloading::Library::new calls dlopen which
            // runs library init code. raylib's init is benign — no
            // global state mutation outside its own private state.
            match unsafe { Library::new(name) } {
                Ok(lib) => return Ok(lib),
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }
        Err(anyhow!(
            "libraylib not found on the host. Tried:\n  {}\n\n\
             Install it via `apt install libraylib-dev` (Debian/Ubuntu), \
             `dnf install raylib` (Fedora), or `brew install raylib` (macOS).",
            errors.join("\n  ")
        ))
    }

    /// Resolve raylib symbols from a loaded library. Returns Err if
    /// any required symbol is missing — we hard-require InitWindow
    /// + SwapScreenBuffer + WindowShouldClose; everything else is
    /// best-effort and missing symbols degrade to no-ops.
    unsafe fn resolve_symbols(&mut self, lib: &Library) -> Result<()> {
        macro_rules! resolve_required {
            ($field:ident, $name:literal, $ty:ty) => {
                let sym: Symbol<$ty> = lib.get($name).map_err(|e| {
                    anyhow!(
                        "symbol {} missing from libraylib: {}",
                        stringify!($name),
                        e
                    )
                })?;
                self.$field = Some(*sym);
            };
        }
        macro_rules! resolve_optional {
            ($field:ident, $name:literal, $ty:ty) => {
                if let Ok(sym) = lib.get::<$ty>($name) {
                    self.$field = Some(*sym);
                }
            };
        }
        resolve_required!(rl_init_window, b"InitWindow\0", RlInitWindow);
        resolve_required!(rl_close_window, b"CloseWindow\0", RlCloseWindow);
        resolve_required!(
            rl_window_should_close,
            b"WindowShouldClose\0",
            RlWindowShouldClose
        );
        resolve_required!(
            rl_swap_screen_buffer,
            b"SwapScreenBuffer\0",
            RlSwapScreenBuffer
        );
        // PollInputEvents exists in raylib 4.x+ but older releases
        // may have called it differently. Optional — degrades to
        // "events only poll during BeginDrawing" behavior which is
        // fine for our pump_events surface.
        resolve_optional!(rl_poll_input_events, b"PollInputEvents\0", RlPollInputEvents);
        resolve_optional!(rl_set_config_flags, b"SetConfigFlags\0", RlSetConfigFlags);
        resolve_optional!(rl_set_target_fps, b"SetTargetFPS\0", RlSetTargetFPS);
        resolve_optional!(rl_get_window_handle, b"GetWindowHandle\0", RlGetWindowHandle);
        resolve_optional!(rl_is_window_ready, b"IsWindowReady\0", RlIsWindowReady);
        Ok(())
    }
}

impl Default for RaylibBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBackend for RaylibBackend {
    fn name(&self) -> &'static str {
        "raylib"
    }

    fn init(&mut self) -> Result<()> {
        if self.lib.is_some() {
            // Already initialised; skip.
            return Ok(());
        }
        let lib = Self::try_load_library()?;
        // SAFETY: resolve_symbols is unsafe because dlsym returns
        // raw function pointers whose type we assert matches the
        // raylib C ABI. Signature correctness is covered by the
        // integration tests — misuse crashes fast on first call.
        unsafe {
            self.resolve_symbols(&lib)?;
        }
        self.lib = Some(lib);
        // Raylib has no separate Init step — the window creation
        // call does the library init implicitly. So this method
        // just loads the library and resolves symbols.
        Ok(())
    }

    fn create_window(
        &mut self,
        title: &str,
        width: u32,
        height: u32,
        flags: WindowFlags,
    ) -> Result<WindowHandle> {
        if self.lib.is_none() {
            return Err(anyhow!(
                "RaylibBackend::create_window called before init"
            ));
        }
        if self.window_active {
            return Err(anyhow!(
                "RaylibBackend already has an active window — raylib only \
                 supports a single window per process"
            ));
        }

        // Apply ConfigFlags BEFORE InitWindow (raylib reads them
        // during init). Silently no-op if the symbol wasn't
        // resolved (older raylib that doesn't expose SetConfigFlags).
        if let Some(set_flags_fn) = self.rl_set_config_flags {
            let mut bits: c_int = 0;
            if flags.resizable {
                bits |= FLAG_WINDOW_RESIZABLE;
            }
            if flags.fullscreen {
                bits |= FLAG_FULLSCREEN_MODE;
            }
            if flags.vsync {
                bits |= FLAG_VSYNC_HINT;
            }
            if bits != 0 {
                unsafe { set_flags_fn(bits) };
            }
        }

        let c_title =
            CString::new(title).map_err(|e| anyhow!("title contains a null byte: {}", e))?;

        let init_fn = self.rl_init_window.expect("resolved in init");
        unsafe {
            init_fn(width as c_int, height as c_int, c_title.as_ptr());
        }
        // Default target FPS to 60 if user didn't specify otherwise.
        // Raylib's frame pacing uses GL swap interval + its own
        // monotonic-clock-based throttle; 60 matches what the other
        // backends emit.
        if let Some(fps_fn) = self.rl_set_target_fps {
            unsafe { fps_fn(60) };
        }

        self.window_active = true;

        // Look up the platform window handle. On Linux raylib
        // returns the X11 Window value as a pointer-sized integer
        // cast to void*. Cast back to u64. On other platforms the
        // returned value isn't an X11 window so leave x11_window_id
        // None and let Path C handle it.
        #[cfg(target_os = "linux")]
        let x11_id: Option<u64> = self.rl_get_window_handle.and_then(|f| {
            let p = unsafe { f() };
            if p.is_null() {
                None
            } else {
                Some(p as usize as u64)
            }
        });
        #[cfg(not(target_os = "linux"))]
        let x11_id: Option<u64> = None;

        // Raylib has no explicit window handle type, so we use the
        // address of a static sentinel byte to give the runner's
        // null-checks something to match against.
        let raw_ptr = &RAYLIB_WINDOW_SENTINEL as *const u8 as *mut c_void;

        Ok(WindowHandle::new(
            raw_ptr,
            std::ptr::null_mut(), // raylib has no separate renderer object
            width,
            height,
            x11_id,
        ))
    }

    fn pump_events(&mut self, out: &mut Vec<BackendEvent>) {
        out.clear();
        if !self.window_active {
            return;
        }
        // Drain raylib's input queue. raylib normally pumps events
        // inside BeginDrawing/EndDrawing, but the runner's present
        // path calls our SwapScreenBuffer directly (not the raylib
        // frame wrapper) so we invoke PollInputEvents explicitly
        // here. If the symbol wasn't resolved, events still get
        // pumped the next time the user's .so calls a raylib draw
        // function — degraded but functional.
        if let Some(poll_fn) = self.rl_poll_input_events {
            unsafe { poll_fn() };
        }
        if let Some(should_close_fn) = self.rl_window_should_close {
            if unsafe { should_close_fn() } != 0 {
                out.push(BackendEvent::Quit);
            }
        }
    }

    fn push_synthetic_event(
        &mut self,
        _kind: u32,
        _payload: *const c_void,
        _payload_size: usize,
    ) -> Result<()> {
        // Raylib has NO synthetic event injection API. Same
        // limitation as GLFW — the runner's remote-input forwarding
        // path needs the manual key-state workaround when running
        // against a raylib project.
        Err(anyhow!(
            "raylib backend does not support synthetic event injection — \
             remote input forwarding requires the manual key-state workaround"
        ))
    }

    fn present_frame(&mut self, handle: &WindowHandle) -> Result<()> {
        if handle.raw_ptr.is_null() {
            return Err(anyhow!("present_frame: window pointer is null"));
        }
        let Some(swap_fn) = self.rl_swap_screen_buffer else {
            return Err(anyhow!("present_frame called before init"));
        };
        unsafe { swap_fn() };
        Ok(())
    }

    fn on_resize(&mut self, handle: &mut WindowHandle, width: u32, height: u32) {
        // Raylib handles resize via its own framebuffer callback;
        // we just update the cached WindowHandle dimensions so
        // downstream code can read them without an FFI call.
        handle.width = width;
        handle.height = height;
    }

    fn destroy_window(&mut self, handle: WindowHandle) {
        if handle.raw_ptr.is_null() {
            return;
        }
        if let Some(close_fn) = self.rl_close_window {
            unsafe { close_fn() };
        }
        self.window_active = false;
    }

    fn shutdown(&mut self) {
        // If destroy_window wasn't called, tear down here.
        if self.window_active {
            if let Some(close_fn) = self.rl_close_window {
                unsafe { close_fn() };
            }
            self.window_active = false;
        }
        // Drop the library handle, unloading libraylib and releasing
        // all its private state. Subsequent init() calls re-load.
        self.lib = None;
        self.rl_init_window = None;
        self.rl_close_window = None;
        self.rl_window_should_close = None;
        self.rl_poll_input_events = None;
        self.rl_swap_screen_buffer = None;
        self.rl_set_config_flags = None;
        self.rl_set_target_fps = None;
        self.rl_get_window_handle = None;
        self.rl_is_window_ready = None;
    }
}
