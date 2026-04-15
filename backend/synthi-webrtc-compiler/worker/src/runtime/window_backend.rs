// ============================================================
// WINDOW BACKEND TRAIT (ULTRAPLAN Lightning Phase 10a)
// ============================================================
//
// Library-agnostic abstraction over the host environment that the
// runner uses to display the user's compiled .so modules. SDL2 has
// been the only backend for the runner's life, so the existing code
// in `runner_bin.rs` calls SDL_* functions directly. This trait
// extracts that surface so we can implement parallel backends for
// GLFW, raylib, sokol, SFML.
//
// ─── Architecture in one paragraph ────────────────────────────
//
// The runner process owns a window + rendering surface that the
// user's gui.so renders INTO via lifecycle callbacks. The runner
// also pumps the host library's event queue, forwards events to
// the user's on_event callback, and pushes synthetic events for
// remote input forwarding. SDL2's runner does this with
// SDL_CreateWindow + SDL_PollEvent + SDL_PushEvent + SDL_RenderPresent.
// A GLFW runner does it with glfwCreateWindow + glfwPollEvents +
// (no synthetic event push — needs a workaround) + glfwSwapBuffers.
// The trait defines the minimum surface every backend has to
// expose for the runner's main loop to drive it.
//
// ─── Phase 10a scope ──────────────────────────────────────────
//
// This commit defines the trait and ships a working SDL2Backend
// implementation. The runner_bin.rs main loop is NOT YET migrated
// to use the trait — that's a separate commit because it's a
// 1000-line refactor of load-bearing HMR + state-bridge + crash-
// isolation code. Keeping the trait extraction separate from the
// runner migration means each can be reviewed and reverted
// independently.
//
// Phase 10b (GLFW) lands a second backend implementation and
// validates that the trait shape is right. If the trait turns
// out to need adjustment after the second impl, the change is
// localized to this file + the two backends — runner_bin.rs is
// untouched.

#![allow(dead_code)]
// ^^ The trait + SDL2Backend are dead code until runner_bin.rs is
// migrated to use them. Suppress the warning until then. The trait
// is not vapor — `#[cfg(test)]` integration tests in the worker
// `tests/` directory exercise it via the public path.

use std::ffi::c_void;
use std::marker::PhantomData;

/// Opaque per-backend window state. The runner stores this as a
/// type-erased handle and only the originating backend reads its
/// internal fields. `raw_ptr` is the backend-specific window
/// pointer (SDL_Window*, GLFWwindow*, sf::Window*, etc.) — the
/// runner never touches it directly; only the backend's own
/// methods do.
///
/// `x11_window_id` is exposed separately so GStreamer capture can
/// work without the backend pointer crossing thread boundaries.
/// Backends that produce X11-backed windows populate this; ones
/// that don't (EGL surfaceless, future Wayland) leave it as
/// `None` and the runner falls through to Path C (Phase 12).
///
/// The handle is intentionally `!Send` via `PhantomData<*const ()>`
/// — raw window pointers are bound to the thread that created
/// them (especially OpenGL contexts), and any attempt to ship the
/// handle across threads is a bug. The runner's main loop is
/// single-threaded by design.
pub struct WindowHandle {
    pub raw_ptr: *mut c_void,
    pub renderer_ptr: *mut c_void,
    pub width: u32,
    pub height: u32,
    /// X11 window ID for GStreamer ximagesrc capture. None when the
    /// backend doesn't produce an X11-backed window.
    pub x11_window_id: Option<u64>,
    _not_send: PhantomData<*const ()>,
}

impl WindowHandle {
    /// Construct a new handle. Pub-restricted to backend implementations
    /// — the runner never calls this directly.
    pub fn new(
        raw_ptr: *mut c_void,
        renderer_ptr: *mut c_void,
        width: u32,
        height: u32,
        x11_window_id: Option<u64>,
    ) -> Self {
        Self {
            raw_ptr,
            renderer_ptr,
            width,
            height,
            x11_window_id,
            _not_send: PhantomData,
        }
    }
}

/// Window creation flags — passthrough from the manifest where
/// available. Backends that don't support a flag (e.g. SDL2 doesn't
/// distinguish OpenGL ES vs desktop GL via this surface) ignore it.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowFlags {
    pub resizable: bool,
    pub fullscreen: bool,
    pub vsync: bool,
    pub opengl: bool,
    pub opengl_version_major: u8,
    pub opengl_version_minor: u8,
    pub opengl_es: bool,
}

/// One pump-cycle event from the backend. The runner does NOT
/// interpret these — it just forwards them to the user's
/// `on_event` callback. Each backend's events are opaque to the
/// runner; the user's compiled .so knows what to do with them
/// because it was compiled against the same library.
///
/// `Quit` is the only event the runner inspects — when it arrives,
/// the runner exits the main loop. Everything else is forwarded
/// raw via the `Raw` variant.
///
/// The `Raw` variant carries a backend-specific event payload as a
/// pointer + length. Backends that have C ABI event types (SDL2's
/// SDL_Event, GLFW's callback args) marshal them into this variant
/// for the runner to forward. Each user .so casts the pointer back
/// to the correct type because it was compiled against the same
/// library.
#[derive(Debug)]
pub enum BackendEvent {
    Quit,
    Resized { width: u32, height: u32 },
    /// Backend-native event payload, forwarded raw to the user's
    /// on_event callback. The runner must NOT free this — the
    /// backend owns the memory and the pointer is only valid until
    /// the next `pump_events` call.
    Raw {
        kind: u32,
        payload: *const c_void,
        payload_size: usize,
    },
}

/// Library-agnostic backend trait. Each backend implements the
/// minimum surface the runner's main loop needs: init, create
/// window, pump events, present frames, shutdown.
///
/// `!Send` by construction (via `WindowHandle`'s PhantomData) —
/// the runner main loop runs on a single thread and any backend
/// state is bound to that thread.
///
/// Methods are in main-loop call order: init → create_window →
/// repeated (pump_events → present_frame) → destroy_window →
/// shutdown.
pub trait WindowBackend {
    /// Human-readable backend name. Used in logs + the StatusBar
    /// pill (`SDL2`, `GLFW`, `raylib`, `sokol`, `SFML`).
    fn name(&self) -> &'static str;

    /// One-shot library init. Called before any window operations.
    /// On failure the runner falls through to Path C (Phase 12) or
    /// bails with a clear error if there's no fallback.
    fn init(&mut self) -> anyhow::Result<()>;

    /// Create the runner's window. Called ONCE per session — HMR
    /// reloads do NOT recreate the window, they just dlclose+dlopen
    /// the user modules into the existing window.
    ///
    /// Returns a `WindowHandle` the runner stores for the lifetime
    /// of the session. The handle is `!Send` and bound to the
    /// calling thread.
    fn create_window(
        &mut self,
        title: &str,
        width: u32,
        height: u32,
        flags: WindowFlags,
    ) -> anyhow::Result<WindowHandle>;

    /// Pump the backend's event queue. Drains all pending events,
    /// returns them in `out`. Called once per frame from the
    /// runner's main loop.
    ///
    /// `out` is reused across calls to avoid per-frame allocation.
    /// Backends should clear it before pushing new events.
    fn pump_events(&mut self, out: &mut Vec<BackendEvent>);

    /// Push a synthetic event into the backend's event queue. Used
    /// by the runner's remote-input forwarding path — when the
    /// frontend sends a key/mouse event over the data channel, the
    /// runner converts it to the backend's native event format and
    /// pushes it here so the user code sees it as a normal event.
    ///
    /// SDL2 supports this via SDL_PushEvent. GLFW does NOT support
    /// synthetic event injection at all — its backend implementation
    /// returns an error for this method, and the runner falls back
    /// to a workaround (e.g. mutating the input state directly via
    /// glfwSetInputMode + manual key state tracking).
    ///
    /// The `kind` and `payload` are backend-specific. Caller is
    /// responsible for marshalling the event correctly.
    fn push_synthetic_event(
        &mut self,
        kind: u32,
        payload: *const c_void,
        payload_size: usize,
    ) -> anyhow::Result<()>;

    /// Present the current frame. SDL2 calls SDL_RenderPresent on
    /// the renderer; GLFW calls glfwSwapBuffers on the window;
    /// raylib calls EndDrawing; sokol calls sg_commit + sapp_frame.
    ///
    /// Called at the END of each frame, after the user's
    /// `gui_on_render` callback has finished drawing.
    fn present_frame(&mut self, handle: &WindowHandle) -> anyhow::Result<()>;

    /// Notify the backend that the window has been resized. The
    /// runner forwards this from the corresponding Resized event
    /// (or from a host-level resize message). Backends update
    /// internal state (GL viewport, texture buffer sizes, etc.).
    fn on_resize(&mut self, handle: &mut WindowHandle, width: u32, height: u32);

    /// Destroy the window. Called once at session end, before
    /// shutdown.
    fn destroy_window(&mut self, handle: WindowHandle);

    /// Library-level shutdown. Called once after destroy_window.
    /// SDL2 calls SDL_Quit; GLFW calls glfwTerminate; raylib calls
    /// CloseWindow; etc.
    fn shutdown(&mut self);
}
