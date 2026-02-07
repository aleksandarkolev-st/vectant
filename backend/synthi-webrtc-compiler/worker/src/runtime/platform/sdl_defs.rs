use std::ffi::{c_int, c_void};

// SDL2 Definitions
#[cfg(target_os = "linux")]
#[allow(non_camel_case_types)]
pub type SDL_Window = c_void;

#[cfg(target_os = "linux")]
#[repr(C)]
pub struct SDL_Event {
    pub data: [u8; 128], // Generous padding for SDL_Event union
}

#[cfg(target_os = "linux")]
#[allow(dead_code)]
#[link(name = "SDL2")]
extern "C" {
    pub fn SDL_Init(flags: u32) -> c_int;
    pub fn SDL_CreateWindow(
        title: *const i8,
        x: c_int,
        y: c_int,
        w: c_int,
        h: c_int,
        flags: u32,
    ) -> *mut SDL_Window;
    pub fn SDL_CreateRenderer(window: *mut SDL_Window, index: c_int, flags: u32) -> *mut c_void;
    pub fn SDL_RenderReadPixels(
        renderer: *mut c_void,
        rect: *const c_void,
        format: u32,
        pixels: *mut c_void,
        pitch: c_int,
    ) -> c_int;
    pub fn SDL_RenderPresent(renderer: *mut c_void);
    pub fn SDL_SetRenderDrawColor(renderer: *mut c_void, r: u8, g: u8, b: u8, a: u8) -> c_int;
    pub fn SDL_RenderClear(renderer: *mut c_void) -> c_int;
    pub fn SDL_CreateTexture(
        renderer: *mut c_void,
        format: u32,
        access: c_int,
        w: c_int,
        h: c_int,
    ) -> *mut c_void;
    pub fn SDL_UpdateTexture(
        texture: *mut c_void,
        rect: *const c_void,
        pixels: *const c_void,
        pitch: c_int,
    ) -> c_int;
    pub fn SDL_RenderCopy(
        renderer: *mut c_void,
        texture: *mut c_void,
        srcrect: *const c_void,
        dstrect: *const c_void,
    ) -> c_int;
    pub fn SDL_PollEvent(event: *mut SDL_Event) -> c_int;
    pub fn SDL_PushEvent(event: *mut SDL_Event) -> c_int;
    pub fn SDL_Quit();
    pub fn SDL_GetError() -> *const i8;
}

// SDL2 Event Types
#[cfg(target_os = "linux")]
pub const SDL_MOUSEMOTION: u32 = 0x400;
#[cfg(target_os = "linux")]
pub const SDL_MOUSEBUTTONDOWN: u32 = 0x401;
#[cfg(target_os = "linux")]
pub const SDL_MOUSEBUTTONUP: u32 = 0x402;
#[cfg(target_os = "linux")]
pub const SDL_KEYDOWN: u32 = 0x300;
#[cfg(target_os = "linux")]
pub const SDL_KEYUP: u32 = 0x301;

pub const SDL_INIT_VIDEO: u32 = 0x00000020;
pub const SDL_WINDOW_SHOWN: u32 = 0x00000004;
pub const SDL_WINDOWPOS_UNDEFINED: c_int = 0x1FFF0000; // SDL_WINDOWPOS_UNDEFINED_MASK | 0
pub const SDL_RENDERER_ACCELERATED: u32 = 0x00000002;
pub const SDL_RENDERER_SOFTWARE: u32 = 0x00000001;
pub const SDL_PIXELFORMAT_RGBA8888: u32 = 373694468;
pub const SDL_TEXTUREACCESS_STREAMING: c_int = 1;

#[cfg(target_os = "linux")]
pub fn create_shm_segment(size: usize) -> Option<(i32, *mut u8)> {
    unsafe {
        let shmid = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o777);
        if shmid == -1 {
            return None;
        }
        let ptr = libc::shmat(shmid, std::ptr::null(), 0);
        if ptr == (-1 as isize as *mut c_void) {
            libc::shmctl(shmid, libc::IPC_RMID, std::ptr::null_mut());
            return None;
        }
        // Mark for destruction
        libc::shmctl(shmid, libc::IPC_RMID, std::ptr::null_mut());
        Some((shmid, ptr as *mut u8))
    }
}

#[cfg(target_os = "linux")]
pub unsafe fn init_sdl() -> (*mut SDL_Window, *mut c_void) {
    if SDL_Init(SDL_INIT_VIDEO) < 0 {
        eprintln!("SDL_Init failed");
        return (std::ptr::null_mut(), std::ptr::null_mut());
    }

    eprintln!("SDL_Init successful.");
    let title = std::ffi::CString::new("Synthi Runner").unwrap();
    let win = SDL_CreateWindow(
        title.as_ptr(),
        SDL_WINDOWPOS_UNDEFINED,
        SDL_WINDOWPOS_UNDEFINED,
        800,
        600,
        SDL_WINDOW_SHOWN,
    );

    if win.is_null() {
        eprintln!("SDL_CreateWindow failed");
        return (std::ptr::null_mut(), std::ptr::null_mut());
    }

    eprintln!("SDL_CreateWindow successful. Window ptr: {:p}", win);
    // Xvfb often crashes with HW acceleration, so we try software first
    let mut ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_SOFTWARE);
    if ren.is_null() {
        eprintln!("Software renderer failed, trying accelerated fallback...");
        ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
    }

    if ren.is_null() {
        eprintln!("SDL_CreateRenderer failed");
    }

    (win, ren)
}
