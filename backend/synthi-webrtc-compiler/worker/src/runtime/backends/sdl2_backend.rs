// ============================================================
// SDL2 BACKEND (ULTRAPLAN Lightning Phase 10a)
// ============================================================
//
// Wraps the existing SDL2 surface from `runtime::platform::sdl_defs`
// in the `WindowBackend` trait. This is the SDL2 reference
// implementation — every other backend (GLFW, raylib, sokol, SFML)
// has to expose the same operations through the same trait.
//
// Phase 10a scope: this module is dead code until runner_bin.rs is
// migrated to use the trait. The tests in `tests/phase10a_*`
// exercise the public path so the implementation is verified
// independently of the runner integration.
//
// ─── Mapping from SDL2 to WindowBackend ──────────────────────
//
//   trait method          → SDL2 call
//   init                  → SDL_Init(SDL_INIT_VIDEO)
//   create_window         → SDL_CreateWindow + SDL_CreateRenderer
//   pump_events           → SDL_PollEvent loop
//   push_synthetic_event  → SDL_PushEvent
//   present_frame         → SDL_RenderPresent
//   destroy_window        → (no-op — runner's existing path drops
//                            window/renderer pointers; SDL_Quit
//                            handles cleanup)
//   shutdown              → SDL_Quit
//
// Limitations (intentional for the MVP):
//   - x11_window_id is populated via SDL_GetWindowID, which returns
//     the SDL window ID (NOT the X11 window ID). For GStreamer
//     ximagesrc capture, the runner currently uses SDL2's window
//     pointer directly — this field is a placeholder until Phase
//     12's ximagesrc rework. The SDL2 backend always returns
//     `Some(sdl_window_id as u64)` so the type is non-None for
//     downstream code that branches on it.
//   - The Resized event variant doesn't fire from this backend
//     yet — the existing runner doesn't handle resizes. Adding it
//     when we wire the trait into runner_bin.rs.

use crate::runtime::platform::sdl_defs::{
    SDL_CreateRenderer, SDL_CreateWindow, SDL_Event, SDL_GetWindowID, SDL_Init, SDL_PollEvent,
    SDL_PushEvent, SDL_Quit, SDL_RenderPresent, SDL_Window, SDL_INIT_VIDEO, SDL_QUIT,
    SDL_RENDERER_ACCELERATED, SDL_RENDERER_SOFTWARE, SDL_WINDOWPOS_UNDEFINED, SDL_WINDOW_SHOWN,
};
use crate::runtime::window_backend::{BackendEvent, WindowBackend, WindowFlags, WindowHandle};
use anyhow::{anyhow, Result};
use std::ffi::{c_void, CString};

pub struct SDL2Backend {
    initialized: bool,
    /// Stable storage for events drained by `pump_events`. Each
    /// call clears and refills this vec; BackendEvent::Raw payload
    /// pointers in the caller's `out` vec reference into this
    /// arena. Phase 10g.3b fix for the previous "pointer-to-stack-
    /// local" bug in pump_events.
    ///
    /// Pre-allocated to hold up to a reasonable number of events
    /// per frame — SDL2's queue rarely exceeds a few dozen entries
    /// in practice (keyboard/mouse/window events). We reserve
    /// capacity to avoid reallocation (which would invalidate all
    /// the pointers in the caller's `out` vec).
    event_arena: Vec<SDL_Event>,
}

/// Maximum events drained per pump cycle. This is the arena's
/// reserved capacity; any event beyond this is dropped. 256 is
/// well above the worst observed SDL2 queue length (~16 during
/// heavy input) and keeps the arena's memory footprint bounded
/// (~14 KB for 256 × 56-byte SDL_Event entries).
const PUMP_EVENT_ARENA_CAPACITY: usize = 256;

impl SDL2Backend {
    pub fn new() -> Self {
        Self {
            initialized: false,
            event_arena: Vec::with_capacity(PUMP_EVENT_ARENA_CAPACITY),
        }
    }
}

impl Default for SDL2Backend {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBackend for SDL2Backend {
    fn name(&self) -> &'static str {
        "SDL2"
    }

    fn init(&mut self) -> Result<()> {
        if self.initialized {
            return Ok(());
        }
        let rc = unsafe { SDL_Init(SDL_INIT_VIDEO) };
        if rc < 0 {
            return Err(anyhow!("SDL_Init(SDL_INIT_VIDEO) failed with code {}", rc));
        }
        self.initialized = true;
        Ok(())
    }

    fn create_window(
        &mut self,
        title: &str,
        width: u32,
        height: u32,
        _flags: WindowFlags,
    ) -> Result<WindowHandle> {
        if !self.initialized {
            return Err(anyhow!("SDL2Backend::create_window called before init"));
        }
        let c_title =
            CString::new(title).map_err(|e| anyhow!("title contains a null byte: {}", e))?;
        let win = unsafe {
            SDL_CreateWindow(
                c_title.as_ptr(),
                SDL_WINDOWPOS_UNDEFINED,
                SDL_WINDOWPOS_UNDEFINED,
                width as i32,
                height as i32,
                SDL_WINDOW_SHOWN,
            )
        };
        if win.is_null() {
            return Err(anyhow!("SDL_CreateWindow returned null"));
        }

        // Try software renderer first (Xvfb is happier with it),
        // fall back to accelerated if software fails. Same logic
        // as the existing init_sdl() in sdl_defs.rs.
        let mut ren = unsafe { SDL_CreateRenderer(win, -1, SDL_RENDERER_SOFTWARE) };
        if ren.is_null() {
            ren = unsafe { SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED) };
        }
        if ren.is_null() {
            return Err(anyhow!(
                "SDL_CreateRenderer failed for both software and accelerated paths"
            ));
        }

        let sdl_window_id = unsafe { SDL_GetWindowID(win as *mut SDL_Window) } as u64;

        Ok(WindowHandle::new(
            win as *mut c_void,
            ren,
            width,
            height,
            // SDL2's "window ID" isn't the X11 window ID — it's
            // SDL's internal handle ID. For GStreamer ximagesrc
            // capture we need the X11 window ID, which requires
            // calling SDL_GetWindowWMInfo + extracting the X11
            // member. Phase 12 (Path C window discovery) introduces
            // that translation; for Phase 10a we expose the SDL
            // window ID and let downstream code branch on Some/None.
            Some(sdl_window_id),
        ))
    }

    fn pump_events(&mut self, out: &mut Vec<BackendEvent>) {
        out.clear();
        // Phase 10g.3b — drain SDL2's queue into the backend-owned
        // event_arena so BackendEvent::Raw pointers are valid until
        // the NEXT pump_events call. Previously this function pushed
        // pointers to stack-local SDL_Event values that went out of
        // scope on the next iteration — undefined behavior the
        // moment the runner tried to read any Raw event.
        //
        // Contract update: Raw.payload points into self.event_arena.
        // The runner must process each event before the NEXT
        // pump_events call (which clears the arena). This matches
        // the existing main-loop shape (events drained + dispatched
        // synchronously, THEN rendering, THEN next frame's pump).
        self.event_arena.clear();

        loop {
            // Stop draining if we hit the arena's reserved capacity.
            // Pushing beyond it would reallocate and invalidate the
            // Raw pointers the runner just read. 256 events/frame
            // is well above any realistic SDL2 workload.
            if self.event_arena.len() >= PUMP_EVENT_ARENA_CAPACITY {
                eprintln!(
                    "[SDL2Backend] pump_events arena full ({} events) — \
                     dropping remaining events until next pump",
                    PUMP_EVENT_ARENA_CAPACITY
                );
                break;
            }

            // SAFETY: SDL_Event is repr(C, align(8)) with 128 bytes
            // of padding (see sdl_defs.rs); zeroing is safe.
            let mut event: SDL_Event = unsafe { std::mem::zeroed() };
            let rc = unsafe { SDL_PollEvent(&mut event) };
            if rc == 0 {
                break;
            }
            // First 4 bytes of SDL_Event are the u32 event type.
            let kind =
                u32::from_ne_bytes([event.data[0], event.data[1], event.data[2], event.data[3]]);

            // Copy the event into the arena. Because we pre-reserved
            // capacity AND we bail at the top of the loop if the
            // arena is full, this push never reallocates, so every
            // existing pointer into the arena stays valid.
            debug_assert!(
                self.event_arena.len() < self.event_arena.capacity(),
                "arena push would reallocate — invariant broken"
            );
            self.event_arena.push(event);
            let stored = self.event_arena.last().expect("just pushed");
            let stored_ptr = stored as *const SDL_Event as *const c_void;

            if kind == SDL_QUIT {
                out.push(BackendEvent::Quit);
                // Still forward as Raw too, in case the runner wants
                // to inspect window ID / timestamp. SDL_QUIT is rare
                // enough that the double-emit cost is irrelevant.
                out.push(BackendEvent::Raw {
                    kind,
                    payload: stored_ptr,
                    payload_size: std::mem::size_of::<SDL_Event>(),
                });
            } else {
                out.push(BackendEvent::Raw {
                    kind,
                    payload: stored_ptr,
                    payload_size: std::mem::size_of::<SDL_Event>(),
                });
            }
        }
    }

    fn push_synthetic_event(
        &mut self,
        _kind: u32,
        payload: *const c_void,
        payload_size: usize,
    ) -> Result<()> {
        if payload.is_null() {
            return Err(anyhow!("push_synthetic_event: payload is null"));
        }
        if payload_size < std::mem::size_of::<SDL_Event>() {
            return Err(anyhow!(
                "push_synthetic_event: payload too small ({} bytes, need {})",
                payload_size,
                std::mem::size_of::<SDL_Event>()
            ));
        }
        // Copy into a local SDL_Event, then push. SDL2 takes a
        // mutable pointer but the call is non-mutating semantically.
        let mut local: SDL_Event = unsafe { std::ptr::read(payload as *const SDL_Event) };
        let rc = unsafe { SDL_PushEvent(&mut local) };
        if rc < 0 {
            return Err(anyhow!("SDL_PushEvent failed with code {}", rc));
        }
        Ok(())
    }

    fn present_frame(&mut self, handle: &WindowHandle) -> Result<()> {
        if handle.renderer_ptr.is_null() {
            return Err(anyhow!("present_frame: renderer_ptr is null"));
        }
        unsafe { SDL_RenderPresent(handle.renderer_ptr) };
        Ok(())
    }

    fn on_resize(&mut self, handle: &mut WindowHandle, width: u32, height: u32) {
        // SDL2 handles resize internally via window events. The
        // runner's existing path doesn't react to resizes, so this
        // is currently a no-op. When we wire the trait into
        // runner_bin.rs and add proper resize handling, this
        // method will update the SDL renderer's logical size.
        handle.width = width;
        handle.height = height;
    }

    fn destroy_window(&mut self, _handle: WindowHandle) {
        // SDL2's runner destroys the window implicitly via
        // SDL_Quit during shutdown — there's no SDL_DestroyWindow
        // call in the existing init_sdl path, and reproducing that
        // behavior keeps Phase 10a behavior-preserving.
        //
        // A more thorough implementation would call SDL_DestroyRenderer
        // + SDL_DestroyWindow here. Adding that when the trait is
        // wired into runner_bin.rs and we have a clean cleanup
        // path to test against.
    }

    fn shutdown(&mut self) {
        if !self.initialized {
            return;
        }
        unsafe { SDL_Quit() };
        self.initialized = false;
    }
}
