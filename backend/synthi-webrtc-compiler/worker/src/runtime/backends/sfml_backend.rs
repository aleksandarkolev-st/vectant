// ============================================================
// SFML BACKEND (ULTRAPLAN Lightning Phase 10e)
// ============================================================
//
// Fourth (now fifth on the plan's count; sokol was dropped —
// see HMR_LIGHTNING_ULTRAPLAN.md §5 rev4 note) concrete
// WindowBackend implementation.
//
// SFML itself is a C++ library with no stable C ABI, so it can't
// be dlopen'd directly — we'd need language-level binding code.
// The CSFML project maintains a stable C API over SFML and ships
// it as distro packages `libcsfml-window`, `libcsfml-graphics`,
// etc. Those ARE dlopen'able, so this backend targets CSFML.
//
// Rendering is via `sfRenderWindow`, which CSFML exposes as an
// opaque pointer. We treat it as the WindowHandle.raw_ptr and
// leave renderer_ptr null (CSFML doesn't have a separate renderer
// object — rendering goes through sfRenderWindow_* calls).
//
// ─── Library name ───────────────────────────────────────────
//
// CSFML splits into multiple sonames per subsystem. The window +
// rendering surface lives in libcsfml-graphics; event polling +
// window create/destroy also come from that library on modern
// versions because graphics re-exports the window ones. We only
// need libcsfml-graphics for the minimum surface.
//
// Tried sonames (in order): libcsfml-graphics.so.2.6,
// libcsfml-graphics.so.2, libcsfml-graphics.so. Older 2.5.x still
// matches the .so.2 soname on most distros.
//
// ─── Method mapping ─────────────────────────────────────────
//
//   trait method          → CSFML call
//   init                  → (no-op; CSFML has no separate init —
//                           create_window does everything)
//   create_window         → sfVideoMode_fromInt + sfRenderWindow_create
//                           + sfRenderWindow_setVerticalSyncEnabled
//                           + sfRenderWindow_getSystemHandle for X11 id
//   pump_events           → sfRenderWindow_pollEvent loop; drops all
//                           events (the user's .so queries SFML state
//                           directly via its own CSFML calls)
//   push_synthetic_event  → NOT SUPPORTED — CSFML has no synthetic
//                           event API; returns Err (same as GLFW/raylib)
//   present_frame         → sfRenderWindow_display
//   destroy_window        → sfRenderWindow_destroy
//   shutdown              → drop the dlopen handle

#![allow(dead_code)]
// Dead code until Phase 10g.2 migrates runner_bin to use the
// WindowBackend trait. Inline + integration tests exercise the
// public surface.

use crate::runtime::window_backend::{BackendEvent, WindowBackend, WindowFlags, WindowHandle};
use anyhow::{anyhow, Result};
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_uint, c_void, CString};

// ─── CSFML types (minimum surface) ─────────────────────────
//
// sfRenderWindow is an opaque struct — we only pass pointers.
// sfVideoMode and sfContextSettings are small C structs with
// documented layouts that are stable across CSFML 2.x.
type SfRenderWindow = c_void;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct SfVideoMode {
    width: c_uint,
    height: c_uint,
    bits_per_pixel: c_uint,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct SfContextSettings {
    depth_bits: c_uint,
    stencil_bits: c_uint,
    antialiasing_level: c_uint,
    major_version: c_uint,
    minor_version: c_uint,
    attribute_flags: c_uint,
    s_rgb_capable: c_uint,
}

impl SfContextSettings {
    fn default_gl33() -> Self {
        Self {
            depth_bits: 24,
            stencil_bits: 8,
            antialiasing_level: 0,
            major_version: 3,
            minor_version: 3,
            attribute_flags: 0,
            s_rgb_capable: 0,
        }
    }
}

// sfWindowStyle bit flags (from CSFML Window/Types.h)
const SF_STYLE_NONE: u32 = 0;
const SF_STYLE_TITLEBAR: u32 = 1 << 0;
const SF_STYLE_RESIZE: u32 = 1 << 1;
const SF_STYLE_CLOSE: u32 = 1 << 2;
const SF_STYLE_FULLSCREEN: u32 = 1 << 3;
const SF_STYLE_DEFAULT: u32 = SF_STYLE_TITLEBAR | SF_STYLE_RESIZE | SF_STYLE_CLOSE;

// sfEventType (minimum — just the ones we inspect)
const SF_EVT_CLOSED: u32 = 0;
const SF_EVT_RESIZED: u32 = 1;

// sfEvent is a C tagged union. For safety we only peek at the
// first u32 (the `type` discriminant). The full layout varies by
// variant and CSFML version, so we don't try to decode bodies —
// the user's .so does that when it calls CSFML directly.
#[repr(C)]
struct SfEventHeader {
    kind: u32,
    // followed by union body — we never touch it
    _padding: [u8; 28], // conservative upper bound for all variants
}

// Function pointer signatures from CSFML Graphics/Window headers.
type SfRenderWindowCreate = unsafe extern "C" fn(
    mode: SfVideoMode,
    title: *const c_char,
    style: u32,
    settings: *const SfContextSettings,
) -> *mut SfRenderWindow;
type SfRenderWindowDestroy = unsafe extern "C" fn(window: *mut SfRenderWindow);
type SfRenderWindowDisplay = unsafe extern "C" fn(window: *mut SfRenderWindow);
type SfRenderWindowIsOpen = unsafe extern "C" fn(window: *const SfRenderWindow) -> c_uint;
type SfRenderWindowPollEvent =
    unsafe extern "C" fn(window: *mut SfRenderWindow, event: *mut SfEventHeader) -> c_uint;
type SfRenderWindowSetVerticalSync =
    unsafe extern "C" fn(window: *mut SfRenderWindow, enabled: c_uint);
type SfRenderWindowGetSystemHandle =
    unsafe extern "C" fn(window: *const SfRenderWindow) -> *mut c_void;
type SfRenderWindowClose = unsafe extern "C" fn(window: *mut SfRenderWindow);

pub struct SFMLBackend {
    lib: Option<Library>,
    sf_create: Option<SfRenderWindowCreate>,
    sf_destroy: Option<SfRenderWindowDestroy>,
    sf_display: Option<SfRenderWindowDisplay>,
    sf_is_open: Option<SfRenderWindowIsOpen>,
    sf_poll_event: Option<SfRenderWindowPollEvent>,
    sf_set_vsync: Option<SfRenderWindowSetVerticalSync>,
    sf_get_system_handle: Option<SfRenderWindowGetSystemHandle>,
    sf_close: Option<SfRenderWindowClose>,
    current_window: Option<*mut SfRenderWindow>,
}

impl SFMLBackend {
    pub fn new() -> Self {
        Self {
            lib: None,
            sf_create: None,
            sf_destroy: None,
            sf_display: None,
            sf_is_open: None,
            sf_poll_event: None,
            sf_set_vsync: None,
            sf_get_system_handle: None,
            sf_close: None,
            current_window: None,
        }
    }

    fn try_load_library() -> Result<Library> {
        let candidates = [
            "libcsfml-graphics.so.2.6",
            "libcsfml-graphics.so.2.5",
            "libcsfml-graphics.so.2",
            "libcsfml-graphics.so",
        ];
        let mut errors = Vec::new();
        for name in &candidates {
            // SAFETY: libloading::Library::new calls dlopen which
            // can run library init code. CSFML's init is benign.
            match unsafe { Library::new(name) } {
                Ok(lib) => return Ok(lib),
                Err(e) => errors.push(format!("{}: {}", name, e)),
            }
        }
        Err(anyhow!(
            "libcsfml-graphics not found on the host. Tried:\n  {}\n\n\
             Install it via `apt install libcsfml-graphics2.6 libcsfml-window2.6` \
             (Debian/Ubuntu) or the equivalent CSFML package on your distro. \
             SFML itself is C++ and not dlopen-friendly; we use CSFML for the \
             C ABI binding.",
            errors.join("\n  ")
        ))
    }

    unsafe fn resolve_symbols(&mut self, lib: &Library) -> Result<()> {
        macro_rules! resolve_required {
            ($field:ident, $name:literal, $ty:ty) => {
                let sym: Symbol<$ty> = lib.get($name).map_err(|e| {
                    anyhow!(
                        "symbol {} missing from libcsfml-graphics: {}",
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
        resolve_required!(sf_create, b"sfRenderWindow_create\0", SfRenderWindowCreate);
        resolve_required!(
            sf_destroy,
            b"sfRenderWindow_destroy\0",
            SfRenderWindowDestroy
        );
        resolve_required!(
            sf_display,
            b"sfRenderWindow_display\0",
            SfRenderWindowDisplay
        );
        resolve_required!(
            sf_poll_event,
            b"sfRenderWindow_pollEvent\0",
            SfRenderWindowPollEvent
        );
        resolve_optional!(sf_is_open, b"sfRenderWindow_isOpen\0", SfRenderWindowIsOpen);
        resolve_optional!(
            sf_set_vsync,
            b"sfRenderWindow_setVerticalSyncEnabled\0",
            SfRenderWindowSetVerticalSync
        );
        resolve_optional!(
            sf_get_system_handle,
            b"sfRenderWindow_getSystemHandle\0",
            SfRenderWindowGetSystemHandle
        );
        resolve_optional!(sf_close, b"sfRenderWindow_close\0", SfRenderWindowClose);
        Ok(())
    }
}

impl Default for SFMLBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBackend for SFMLBackend {
    fn name(&self) -> &'static str {
        "SFML"
    }

    fn init(&mut self) -> Result<()> {
        if self.lib.is_some() {
            return Ok(());
        }
        let lib = Self::try_load_library()?;
        // SAFETY: see resolve_symbols signature assertions.
        unsafe {
            self.resolve_symbols(&lib)?;
        }
        self.lib = Some(lib);
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
            return Err(anyhow!("SFMLBackend::create_window called before init"));
        }
        let create_fn = self.sf_create.expect("resolved in init");

        let mode = SfVideoMode {
            width: width as c_uint,
            height: height as c_uint,
            bits_per_pixel: 32,
        };
        let settings = SfContextSettings::default_gl33();

        let mut style: u32 = if flags.fullscreen {
            SF_STYLE_FULLSCREEN
        } else {
            SF_STYLE_DEFAULT
        };
        if !flags.resizable {
            style &= !SF_STYLE_RESIZE;
        }

        let c_title =
            CString::new(title).map_err(|e| anyhow!("title contains a null byte: {}", e))?;

        let window = unsafe {
            create_fn(
                mode,
                c_title.as_ptr(),
                style,
                &settings as *const SfContextSettings,
            )
        };
        if window.is_null() {
            return Err(anyhow!(
                "sfRenderWindow_create returned null — likely missing display, \
                 OpenGL context creation failure, or incompatible settings"
            ));
        }

        if let Some(vsync_fn) = self.sf_set_vsync {
            unsafe { vsync_fn(window, if flags.vsync { 1 } else { 0 }) };
        }

        // Try to get the X11 window ID. CSFML's
        // sfRenderWindow_getSystemHandle returns sfWindowHandle which
        // on Linux is the X11 Window value cast to void*. On other
        // platforms it's something else and we leave x11_window_id
        // as None.
        #[cfg(target_os = "linux")]
        let x11_id: Option<u64> = self.sf_get_system_handle.and_then(|f| {
            let p = unsafe { f(window as *const _) };
            if p.is_null() {
                None
            } else {
                Some(p as usize as u64)
            }
        });
        #[cfg(not(target_os = "linux"))]
        let x11_id: Option<u64> = None;

        self.current_window = Some(window);
        Ok(WindowHandle::new(
            window as *mut c_void,
            std::ptr::null_mut(), // CSFML has no separate renderer pointer
            width,
            height,
            x11_id,
        ))
    }

    fn pump_events(&mut self, out: &mut Vec<BackendEvent>) {
        out.clear();
        let Some(window) = self.current_window else {
            return;
        };
        let Some(poll_fn) = self.sf_poll_event else {
            return;
        };
        // Drain every pending CSFML event and look only at the
        // discriminant. Body bytes are backend-private; the user's
        // .so reads its own event state via CSFML directly.
        loop {
            let mut ev = SfEventHeader {
                kind: 0,
                _padding: [0; 28],
            };
            let has_event = unsafe { poll_fn(window, &mut ev as *mut _) };
            if has_event == 0 {
                break;
            }
            match ev.kind {
                SF_EVT_CLOSED => out.push(BackendEvent::Quit),
                SF_EVT_RESIZED => {
                    // Size data lives in the union body — we can't
                    // safely decode it without a per-version layout,
                    // so we emit a stub Resized with zeroes. The
                    // runner treats it as a "something changed"
                    // signal and re-queries the window dimensions
                    // through normal channels.
                    out.push(BackendEvent::Resized {
                        width: 0,
                        height: 0,
                    });
                }
                _ => {
                    // Other events are forwarded raw so the user's
                    // .so (which understands CSFML's event union)
                    // can handle them. payload is NOT valid after
                    // the next pump_events call — the runner's
                    // on_event handler must consume immediately.
                    // For MVP we don't forward raw events since the
                    // user code has direct CSFML access; drop.
                }
            }
        }
    }

    fn push_synthetic_event(
        &mut self,
        _kind: u32,
        _payload: *const c_void,
        _payload_size: usize,
    ) -> Result<()> {
        Err(anyhow!(
            "SFML backend does not support synthetic event injection — \
             remote input forwarding requires the manual key-state workaround"
        ))
    }

    fn present_frame(&mut self, handle: &WindowHandle) -> Result<()> {
        if handle.raw_ptr.is_null() {
            return Err(anyhow!("present_frame: window pointer is null"));
        }
        let Some(display_fn) = self.sf_display else {
            return Err(anyhow!("present_frame called before init"));
        };
        unsafe { display_fn(handle.raw_ptr as *mut SfRenderWindow) };
        Ok(())
    }

    fn on_resize(&mut self, handle: &mut WindowHandle, width: u32, height: u32) {
        handle.width = width;
        handle.height = height;
    }

    fn destroy_window(&mut self, handle: WindowHandle) {
        if handle.raw_ptr.is_null() {
            return;
        }
        // If close is available, call it first — lets SFML do a
        // clean teardown of OpenGL state before we free the struct.
        if let Some(close_fn) = self.sf_close {
            unsafe { close_fn(handle.raw_ptr as *mut SfRenderWindow) };
        }
        if let Some(destroy_fn) = self.sf_destroy {
            unsafe { destroy_fn(handle.raw_ptr as *mut SfRenderWindow) };
        }
        if self.current_window == Some(handle.raw_ptr as *mut SfRenderWindow) {
            self.current_window = None;
        }
    }

    fn shutdown(&mut self) {
        // If destroy_window wasn't called, tear the window down here.
        if let Some(window) = self.current_window.take() {
            if let Some(close_fn) = self.sf_close {
                unsafe { close_fn(window) };
            }
            if let Some(destroy_fn) = self.sf_destroy {
                unsafe { destroy_fn(window) };
            }
        }
        // Drop the library handle, unloading libcsfml-graphics.
        self.lib = None;
        self.sf_create = None;
        self.sf_destroy = None;
        self.sf_display = None;
        self.sf_is_open = None;
        self.sf_poll_event = None;
        self.sf_set_vsync = None;
        self.sf_get_system_handle = None;
        self.sf_close = None;
    }
}
