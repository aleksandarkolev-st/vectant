#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::xproto::*;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::ConnectionExt as ShmConnectionExt;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
#[cfg(target_os = "linux")]
use std::ptr;
#[cfg(target_os = "linux")]
use std::ffi::c_void;
#[cfg(target_os = "linux")]
use std::sync::mpsc;
#[cfg(target_os = "linux")]
use crate::runtime::platform::sdl_defs::*;

#[cfg(target_os = "linux")]
pub fn create_shm_segment(size: usize) -> Option<(i32, *mut u8)> {
    unsafe {
        let shmid = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o777);
        if shmid == -1 {
            return None;
        }
        let ptr = libc::shmat(shmid, ptr::null(), 0);
        if ptr == (-1 as isize as *mut c_void) {
            libc::shmctl(shmid, libc::IPC_RMID, ptr::null_mut());
            return None;
        }
        // Mark for destruction
        libc::shmctl(shmid, libc::IPC_RMID, ptr::null_mut());
        Some((shmid, ptr as *mut u8))
    }
}

#[cfg(target_os = "linux")]
pub fn capture_frame(
    x11_conn: &impl Connection,
    x11_root: Window,
    shm_seg: Seg,
    shm_ptr: *mut u8,
    frame_tx: &mpsc::SyncSender<Vec<u8>>,
    frame_count: &mut u64,
    frames_sent: &mut u64,
    last_frame_log: &mut Instant,
) {
    // Pixel Pump: Read from Xvfb via XShm
    // We need to capture from the plugin's window, not root.
    // Root window captures don't include child windows unless a compositor is running.
    // Query the window tree to find the plugin's window (child of root).
    let target_window = if let Ok(tree_reply) = x11_conn.query_tree(x11_root) {
        if let Ok(reply) = tree_reply.reply() {
            // Find a mapped child window that's not the SDL window
            // The plugin's window should be the most recently mapped non-SDL window
            let mut found_window = None;

            // Log window count periodically
            if last_frame_log.elapsed() > Duration::from_secs(4) {
                eprintln!(
                    "[Runner] query_tree found {} children of root",
                    reply.children.len()
                );
            }

            for &child in reply.children.iter().rev() {
                // Check if window is mapped (viewable)
                if let Ok(attrs) = x11_conn.get_window_attributes(child) {
                    if let Ok(attr_reply) = attrs.reply() {
                        if attr_reply.map_state
                            == MapState::VIEWABLE
                        {
                            found_window = Some(child);
                            break;
                        }
                    }
                }
            }
            if last_frame_log.elapsed() > Duration::from_secs(4) {
                eprintln!("[Runner] Found viewable window: {:?}", found_window);
            }
            found_window.unwrap_or(x11_root)
        } else {
            if last_frame_log.elapsed() > Duration::from_secs(4) {
                eprintln!("[Runner] query_tree reply failed");
            }
            x11_root
        }
    } else {
        if last_frame_log.elapsed() > Duration::from_secs(4) {
            eprintln!("[Runner] query_tree failed");
        }
        x11_root
    };

    // The output must always be 800x600 to match the GStreamer pipeline caps
    const OUTPUT_W: u16 = 800;
    const OUTPUT_H: u16 = 600;

    // Get the actual window size to capture
    let (win_w, win_h): (u16, u16) = if target_window != x11_root {
        if let Ok(geom) = x11_conn.get_geometry(target_window) {
            if let Ok(g) = geom.reply() {
                if last_frame_log.elapsed() > Duration::from_secs(4) {
                    eprintln!("[Runner] Target window geometry: {}x{}", g.width, g.height);
                }
                (g.width, g.height)
            } else {
                (OUTPUT_W, OUTPUT_H)
            }
        } else {
            (OUTPUT_W, OUTPUT_H)
        }
    } else {
        (OUTPUT_W, OUTPUT_H)
    };

    // Capture size is the minimum of window size and output size
    let capture_w = win_w.min(OUTPUT_W);
    let capture_h = win_h.min(OUTPUT_H);

    // Capture from the target window (plugin's window, or root as fallback)
    if let Ok(cookie) = x11_conn.shm_get_image(
        target_window,
        0,
        0,
        capture_w,
        capture_h,
        !0,
        u8::from(ImageFormat::Z_PIXMAP),
        shm_seg,
        0,
    ) {
        if let Ok(_reply) = cookie.reply() {
            // If captured size differs from output size, we need to reformat
            // the buffer to have 800-pixel row stride for the pipeline
            let output_size = (OUTPUT_W as usize) * (OUTPUT_H as usize) * 4;

            let frame_data = if capture_w == OUTPUT_W && capture_h == OUTPUT_H {
                // Perfect match, use directly
                unsafe { std::slice::from_raw_parts(shm_ptr, output_size).to_vec() }
            } else {
                // Need to convert: captured rows have capture_w*4 bytes,
                // but output rows need OUTPUT_W*4 bytes
                let mut output_buf = vec![0u8; output_size];
                let capture_stride = (capture_w as usize) * 4;
                let output_stride = (OUTPUT_W as usize) * 4;

                for y in 0..(capture_h as usize) {
                    let src_offset = y * capture_stride;
                    let dst_offset = y * output_stride;
                    unsafe {
                        ptr::copy_nonoverlapping(
                            shm_ptr.add(src_offset),
                            output_buf.as_mut_ptr().add(dst_offset),
                            capture_stride,
                        );
                    }
                }
                output_buf
            };

            *frame_count += 1;

            // Drop frame if stdout is backed up; keep the app loop unblocked
            match frame_tx.try_send(frame_data.clone()) {
                Ok(_) => {
                    *frames_sent += 1;
                }
                Err(_) => { /* Channel full or closed; skip this frame */ }
            }

            // Log frame stats periodically (using separate timer)
            if last_frame_log.elapsed() > Duration::from_secs(5) {
                eprintln!(
                    "[Runner] Frame stats: captured={}, sent={}, dropped={}",
                    frame_count,
                    frames_sent,
                    *frame_count - *frames_sent
                );
                *last_frame_log = Instant::now();
            }
        }
    }
}
