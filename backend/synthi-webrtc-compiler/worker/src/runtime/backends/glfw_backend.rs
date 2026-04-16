// ============================================================
// GLFW BACKEND (ULTRAPLAN Lightning Phase 10b)
// ============================================================
//
// Second backend implementation for the `WindowBackend` trait. Uses
// `libloading` to dlopen `libglfw.so` at runtime — the worker binary
// is NOT statically linked against GLFW. Deployment environments
// that want GLFW projects to work must `apt install libglfw3` (or
// equivalent). Worker binary stays small and the deployment
// installs only the libraries it actually serves.
//
// This is the second concrete implementation of WindowBackend. If
// the trait shape needed adjustment, this is where we'd find out.
// (So far, so good.)
//
// ─── Mapping from GLFW to WindowBackend ──────────────────────
//
//   trait method          → GLFW call
//   init                  → glfwInit
//   create_window         → glfwWindowHint × N + glfwCreateWindow +
//                           glfwMakeContextCurrent + glfwSwapInterval
//   pump_events           → glfwPollEvents (callbacks fire — events
//                           accumulate in a thread-local buffer)
//   push_synthetic_event  → NOT SUPPORTED — returns Err. GLFW has
//                           no synthetic event injection API. The
//                           runner will fall back to a workaround
//                           (manual key-state tracking) when remote
//                           input forwarding is enabled.
//   present_frame         → glfwSwapBuffers
//   destroy_window        → glfwDestroyWindow
//   shutdown              → glfwTerminate
//
// ─── Lazy library load ───────────────────────────────────────
//
// GLFWBackend::new() does NOT load libglfw.so. The library is
// loaded on the first call to `init()`. This means constructing the
// backend is cheap (no I/O, no FFI errors) and the runtime check
// for "is GLFW available" happens at the right point — when the
// runner actually tries to use it. If the library isn't installed,
// `init()` returns an error and the runner falls through to Path C
// (Phase 12).
//
// `Library` is held in `Option<Library>` so we can drop it during
// `shutdown()` and release the dlopen handle. Symbol resolution
// happens once during `init()` and the resolved function pointers
// are cached on the struct.
//
// ─── Why NOT use a glfw-rs / glfw-sys cargo crate? ──────────
//
// Per rev3 §10b, build-time bindings would (1) make libglfw a
// hard build-time dependency (slow build, large image), and (2)
// version-lock to whatever the binding crate supports. Runtime
// dlopen sidesteps both — the binding lives entirely in this file
// as a Rust struct of function pointers, and we can run against
// any libglfw3 ABI-compatible release.

use crate::runtime::window_backend::{
    BackendEvent, WindowBackend, WindowFlags, WindowHandle,
};
use anyhow::{anyhow, Result};
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_int, c_void, CString};

// ─── GLFW C API types (minimum surface we use) ─────────────
//
// We declare these as opaque pointers because we never inspect
// the internals — only pass them through to the GLFW functions
// and back to the user code.

type GLFWwindow = c_void;
type GLFWmonitor = c_void;

// GLFW window hint constants. Hardcoded to match libglfw3's ABI.
// These are stable across GLFW 3.x releases.
const GLFW_CONTEXT_VERSION_MAJOR: c_int = 0x00022002;
const GLFW_CONTEXT_VERSION_MINOR: c_int = 0x00022003;
const GLFW_OPENGL_PROFILE: c_int = 0x00022008;
const GLFW_OPENGL_CORE_PROFILE: c_int = 0x00032001;
const GLFW_RESIZABLE: c_int = 0x00020003;
const GLFW_VISIBLE: c_int = 0x00020004;
const GLFW_CLIENT_API: c_int = 0x00022001;
const GLFW_OPENGL_API: c_int = 0x00030001;
const GLFW_OPENGL_ES_API: c_int = 0x00030002;
const GLFW_TRUE: c_int = 1;
const GLFW_FALSE: c_int = 0;

// Function pointer signatures matching the libglfw3 ABI. Each
// `Option<...>` is filled in during `init()` via dlsym.
type GlfwInit = unsafe extern "C" fn() -> c_int;
type GlfwTerminate = unsafe extern "C" fn();
type GlfwWindowHint = unsafe extern "C" fn(hint: c_int, value: c_int);
type GlfwCreateWindow = unsafe extern "C" fn(
    width: c_int,
    height: c_int,
    title: *const c_char,
    monitor: *mut GLFWmonitor,
    share: *mut GLFWwindow,
) -> *mut GLFWwindow;
type GlfwDestroyWindow = unsafe extern "C" fn(window: *mut GLFWwindow);
type GlfwMakeContextCurrent = unsafe extern "C" fn(window: *mut GLFWwindow);
type GlfwSwapBuffers = unsafe extern "C" fn(window: *mut GLFWwindow);
type GlfwSwapInterval = unsafe extern "C" fn(interval: c_int);
type GlfwPollEvents = unsafe extern "C" fn();
type GlfwWindowShouldClose = unsafe extern "C" fn(window: *mut GLFWwindow) -> c_int;
type GlfwGetX11Window = unsafe extern "C" fn(window: *mut GLFWwindow) -> u64;

pub struct GLFWBackend {
    /// Held to keep the library mapped for the lifetime of the
    /// backend. Dropped during `shutdown()` to release the dlopen
    /// handle.
    lib: Option<Library>,
    /// Resolved function pointers, populated during `init()`.
    /// Wrapped in Option so the struct can be constructed before
    /// init runs.
    glfw_init: Option<GlfwInit>,
    glfw_terminate: Option<GlfwTerminate>,
    glfw_window_hint: Option<GlfwWindowHint>,
    glfw_create_window: Option<GlfwCreateWindow>,
    glfw_destroy_window: Option<GlfwDestroyWindow>,
    glfw_make_context_current: Option<GlfwMakeContextCurrent>,
    glfw_swap_buffers: Option<GlfwSwapBuffers>,
    glfw_swap_interval: Option<GlfwSwapInterval>,
    glfw_poll_events: Option<GlfwPollEvents>,
    glfw_window_should_close: Option<GlfwWindowShouldClose>,
    glfw_get_x11_window: Option<GlfwGetX11Window>,
    /// The window we created. Stored so pump_events can call
    /// glfwWindowShouldClose without needing to thread the handle
    /// through every method.
    current_window: Option<*mut GLFWwindow>,
}

impl GLFWBackend {
    pub fn new() -> Self {
        Self {
            lib: None,
            glfw_init: None,
            glfw_terminate: None,
            glfw_window_hint: None,
            glfw_create_window: None,
            glfw_destroy_window: None,
            glfw_make_context_current: None,
            glfw_swap_buffers: None,
            glfw_swap_interval: None,
            glfw_poll_events: None,
            glfw_window_should_close: None,
            glfw_get_x11_window: None,
            current_window: None,
        }
    }

    /// Try to dlopen libglfw3 under the standard names. Returns the
    /// loaded Library on success, an Err describing every attempted
    /// path on failure. Tries multiple sonames to handle distro
    /// variation (`libglfw.so.3`, `libglfw.so`, `libglfw3.so`).
    fn try_load_library() -> Result<Library> {
        let candidates = ["libglfw.so.3", "libglfw.so", "libglfw3.so"];
        let mut errors = Vec::new();
        for name in &candidates {
            // SAFETY: libloading::Library::new is unsafe because it
            // calls dlopen which can run library init code. GLFW's
            // init is benign — no global state mutation outside
            // its own private state.
            match unsafe { Library::new(name) } {
                Ok(lib) => return Ok(lib),
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }
        Err(anyhow!(
            "libglfw3 not found on the host. Tried:\n  {}\n\n\
             Install it via `apt install libglfw3` (Debian/Ubuntu), \
             `dnf install glfw` (Fedora), or `brew install glfw` (macOS).",
            errors.join("\n  ")
        ))
    }

    /// Resolve the GLFW symbols we need from a loaded library.
    /// Returns Err if any required symbol is missing.
    unsafe fn resolve_symbols(&mut self, lib: &Library) -> Result<()> {
        macro_rules! resolve {
            ($field:ident, $name:literal, $ty:ty) => {
                let sym: Symbol<$ty> = lib
                    .get($name)
                    .map_err(|e| anyhow!("symbol {} missing from libglfw: {}", stringify!($name), e))?;
                self.$field = Some(*sym);
            };
        }
        resolve!(glfw_init, b"glfwInit\0", GlfwInit);
        resolve!(glfw_terminate, b"glfwTerminate\0", GlfwTerminate);
        resolve!(glfw_window_hint, b"glfwWindowHint\0", GlfwWindowHint);
        resolve!(glfw_create_window, b"glfwCreateWindow\0", GlfwCreateWindow);
        resolve!(glfw_destroy_window, b"glfwDestroyWindow\0", GlfwDestroyWindow);
        resolve!(
            glfw_make_context_current,
            b"glfwMakeContextCurrent\0",
            GlfwMakeContextCurrent
        );
        resolve!(glfw_swap_buffers, b"glfwSwapBuffers\0", GlfwSwapBuffers);
        resolve!(glfw_swap_interval, b"glfwSwapInterval\0", GlfwSwapInterval);
        resolve!(glfw_poll_events, b"glfwPollEvents\0", GlfwPollEvents);
        resolve!(
            glfw_window_should_close,
            b"glfwWindowShouldClose\0",
            GlfwWindowShouldClose
        );
        // glfwGetX11Window lives in libglfw3 only when the binary
        // was built with X11 native-access support. Most distro
        // builds have it. If missing, we fall back to None and
        // the WindowHandle.x11_window_id stays None — Path C
        // fallback handles that case.
        if let Ok(sym) = lib.get::<GlfwGetX11Window>(b"glfwGetX11Window\0") {
            self.glfw_get_x11_window = Some(*sym);
        }
        Ok(())
    }
}

impl Default for GLFWBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBackend for GLFWBackend {
    fn name(&self) -> &'static str {
        "GLFW"
    }

    fn init(&mut self) -> Result<()> {
        if self.lib.is_some() {
            // Already initialised
            return Ok(());
        }
        let lib = Self::try_load_library()?;
        // SAFETY: see resolve_symbols comment
        unsafe {
            self.resolve_symbols(&lib)?;
        }
        self.lib = Some(lib);
        // Call glfwInit
        let init_fn = self.glfw_init.expect("init resolved above");
        let rc = unsafe { init_fn() };
        if rc != GLFW_TRUE {
            return Err(anyhow!("glfwInit returned {} (failure)", rc));
        }
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
            return Err(anyhow!("GLFWBackend::create_window called before init"));
        }
        let hint_fn = self.glfw_window_hint.expect("init resolved");
        let create_fn = self.glfw_create_window.expect("init resolved");
        let make_current_fn = self.glfw_make_context_current.expect("init resolved");
        let swap_interval_fn = self.glfw_swap_interval.expect("init resolved");

        // Apply window hints from flags
        unsafe {
            hint_fn(
                GLFW_RESIZABLE,
                if flags.resizable { GLFW_TRUE } else { GLFW_FALSE },
            );
            hint_fn(GLFW_VISIBLE, GLFW_TRUE);
            if flags.opengl {
                hint_fn(
                    GLFW_CLIENT_API,
                    if flags.opengl_es {
                        GLFW_OPENGL_ES_API
                    } else {
                        GLFW_OPENGL_API
                    },
                );
                if flags.opengl_version_major > 0 {
                    hint_fn(
                        GLFW_CONTEXT_VERSION_MAJOR,
                        flags.opengl_version_major as c_int,
                    );
                    hint_fn(
                        GLFW_CONTEXT_VERSION_MINOR,
                        flags.opengl_version_minor as c_int,
                    );
                    hint_fn(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
                }
            }
        }

        let c_title =
            CString::new(title).map_err(|e| anyhow!("title contains a null byte: {}", e))?;

        let win = unsafe {
            create_fn(
                width as c_int,
                height as c_int,
                c_title.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if win.is_null() {
            return Err(anyhow!(
                "glfwCreateWindow returned null — likely missing display, \
                 OpenGL driver, or incompatible OpenGL version request"
            ));
        }

        unsafe {
            make_current_fn(win);
            if flags.vsync {
                swap_interval_fn(1);
            } else {
                swap_interval_fn(0);
            }
        }

        // Try to get the X11 window ID. None if glfwGetX11Window
        // wasn't available or returned 0.
        let x11_id = self
            .glfw_get_x11_window
            .map(|f| unsafe { f(win) })
            .filter(|&id| id != 0);

        self.current_window = Some(win);
        Ok(WindowHandle::new(
            win as *mut c_void,
            std::ptr::null_mut(), // GLFW has no separate renderer object
            width,
            height,
            x11_id,
        ))
    }

    fn pump_events(&mut self, out: &mut Vec<BackendEvent>) {
        out.clear();
        let Some(poll_fn) = self.glfw_poll_events else {
            return;
        };
        let Some(should_close_fn) = self.glfw_window_should_close else {
            return;
        };
        // GLFW pumps events into its registered callbacks. We
        // don't register any callbacks (yet) so this drains the
        // OS event queue and updates internal GLFW state. The
        // user's .so polls input state directly via glfwGetKey /
        // glfwGetMousePosition / etc. — they don't need the
        // events to be forwarded through our trait.
        unsafe { poll_fn() };

        // Check window-close state and emit Quit if it was set.
        if let Some(window) = self.current_window {
            if unsafe { should_close_fn(window) } != 0 {
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
        // GLFW has NO synthetic event injection API. The runner's
        // remote-input forwarding path needs to use a workaround
        // for GLFW projects (e.g. tracking key state in a
        // sidecar map and updating it directly when remote events
        // arrive — Phase 10b.1 follow-up).
        Err(anyhow!(
            "GLFW backend does not support synthetic event injection — \
             remote input forwarding requires the manual key-state workaround"
        ))
    }

    fn present_frame(&mut self, handle: &WindowHandle) -> Result<()> {
        if handle.raw_ptr.is_null() {
            return Err(anyhow!("present_frame: window pointer is null"));
        }
        let Some(swap_fn) = self.glfw_swap_buffers else {
            return Err(anyhow!("present_frame called before init"));
        };
        unsafe { swap_fn(handle.raw_ptr as *mut GLFWwindow) };
        Ok(())
    }

    fn on_resize(&mut self, handle: &mut WindowHandle, width: u32, height: u32) {
        // GLFW's framebuffer resize callback handles this internally.
        // We just update the WindowHandle's cached dimensions so
        // downstream code can read them without going through GLFW.
        handle.width = width;
        handle.height = height;
    }

    fn destroy_window(&mut self, handle: WindowHandle) {
        if handle.raw_ptr.is_null() {
            return;
        }
        if let Some(destroy_fn) = self.glfw_destroy_window {
            unsafe { destroy_fn(handle.raw_ptr as *mut GLFWwindow) };
        }
        if self.current_window == Some(handle.raw_ptr as *mut GLFWwindow) {
            self.current_window = None;
        }
    }

    fn shutdown(&mut self) {
        if let Some(terminate_fn) = self.glfw_terminate {
            unsafe { terminate_fn() };
        }
        // Drop the library handle. This unloads libglfw3 and frees
        // any internal GLFW state. Subsequent calls to init() will
        // re-load it.
        self.lib = None;
        self.glfw_init = None;
        self.glfw_terminate = None;
        self.glfw_window_hint = None;
        self.glfw_create_window = None;
        self.glfw_destroy_window = None;
        self.glfw_make_context_current = None;
        self.glfw_swap_buffers = None;
        self.glfw_swap_interval = None;
        self.glfw_poll_events = None;
        self.glfw_window_should_close = None;
        self.glfw_get_x11_window = None;
        self.current_window = None;
    }
}
