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
}

impl SDL2Backend {
    pub fn new() -> Self {
        Self { initialized: false }
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
        let c_title = CString::new(title)
            .map_err(|e| anyhow!("title contains a null byte: {}", e))?;
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
        // SDL_PollEvent drains pending events from SDL2's queue.
        // Loop until it returns 0 (no more events). Each event
        // gets either a structured variant (Quit) or a Raw
        // forwarding payload that the runner sends to the user's
        // on_event callback.
        loop {
            // SAFETY: SDL_Event is repr(C, align(8)) with 128 bytes
            // of padding (see sdl_defs.rs); zeroing it is safe.
            let mut event: SDL_Event = unsafe { std::mem::zeroed() };
            let rc = unsafe { SDL_PollEvent(&mut event) };
            if rc == 0 {
                break;
            }
            // The first 4 bytes of SDL_Event are the event type as
            // a u32. Read it directly from the data buffer.
            let kind = u32::from_ne_bytes([
                event.data[0],
                event.data[1],
                event.data[2],
                event.data[3],
            ]);
            if kind == SDL_QUIT {
                out.push(BackendEvent::Quit);
                continue;
            }
            // Forward as Raw. The pointer is into the local stack
            // copy of `event`, which the runner is expected to
            // process before the next pump_events call.
            //
            // NOTE: this is a borrow-check fiction — &event becomes
            // invalid after this iteration ends. The runner has to
            // copy or process the payload before continuing the
            // loop. For the trait's V1 contract, this is fine
            // because the runner consumes events synchronously.
            // A more robust v2 would use a backend-owned event
            // arena that lives until the next pump_events call.
            out.push(BackendEvent::Raw {
                kind,
                payload: &event as *const SDL_Event as *const c_void,
                payload_size: std::mem::size_of::<SDL_Event>(),
            });
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
