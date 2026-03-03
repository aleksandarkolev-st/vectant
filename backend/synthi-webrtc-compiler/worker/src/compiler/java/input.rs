//! X11 input injection for Java GUI apps.
//!
//! Receives SDL-format input commands from the main worker event router
//! (which converts browser GUI events into `input <cmd>` strings) and
//! translates them into `xdotool` invocations on the Xvfb display.
//!
//! Command format from main.rs:
//!   input motion <x> <y>
//!   input button <down|up> <btn> <x> <y>
//!   input key <down|up> <sdl_keycode>
//!
//! The C++ stages runner writes these same commands to the SDL process's
//! stdin.  Here we translate them to equivalent X11 events via xdotool.

use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Minimum interval between mousemove commands (≈60 fps cap).
/// Without throttling, rapid mouse events flood the display with
/// xdotool processes that each take ~5-10ms to spawn.
const MOUSE_MOVE_MIN_INTERVAL: Duration = Duration::from_millis(16);

/// Spawn a background task that reads input commands and injects them
/// into the X11 display via xdotool.
///
/// `display` is the DISPLAY string (e.g. ":99").
/// Returns the sender half; drop it to shut down the task.
pub fn spawn_input_task(display: String) -> mpsc::UnboundedSender<String> {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(run_input_loop(display, rx));
    tx
}

async fn run_input_loop(display: String, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut last_move = Instant::now() - MOUSE_MOVE_MIN_INTERVAL;

    while let Some(cmd) = rx.recv().await {
        for line in cmd.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let rest = match line.strip_prefix("input ") {
                Some(r) => r,
                None => {
                    // Not an input command — ignore
                    continue;
                }
            };

            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            match parts[0] {
                // ── Mouse motion ──────────────────────────────────
                // format: motion <x> <y>
                "motion" if parts.len() >= 3 => {
                    let now = Instant::now();
                    if now.duration_since(last_move) < MOUSE_MOVE_MIN_INTERVAL {
                        continue; // throttle
                    }
                    last_move = now;
                    xdotool(&display, &[
                        "mousemove", "--screen", "0", parts[1], parts[2],
                    ])
                    .await;
                }

                // ── Mouse button ─────────────────────────────────
                // format: button <down|up> <btn> <x> <y>
                "button" if parts.len() >= 5 => {
                    // Move to coordinates first, then press/release
                    xdotool(&display, &[
                        "mousemove", "--screen", "0", parts[3], parts[4],
                    ])
                    .await;
                    let action = if parts[1] == "down" { "mousedown" } else { "mouseup" };
                    xdotool(&display, &[action, parts[2]]).await;
                }

                // ── Keyboard ─────────────────────────────────────
                // format: key <down|up> <sdl_keycode>
                "key" if parts.len() >= 3 => {
                    let direction = parts[1]; // "down" or "up"
                    let sdlk: i64 = match parts[2].parse() {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let xkey = match sdl_keycode_to_xdotool(sdlk) {
                        Some(k) => k,
                        None => continue,
                    };
                    let action = if direction == "down" { "keydown" } else { "keyup" };
                    xdotool(&display, &[action, &xkey]).await;
                }

                _ => {
                    // Unknown command — skip silently
                }
            }
        }
    }
    eprintln!("[JavaInput] Input loop ended");
}

/// Run a single xdotool command. Fire-and-forget (don't wait for exit).
async fn xdotool(display: &str, args: &[&str]) {
    let mut cmd = Command::new("xdotool");
    cmd.env("DISPLAY", display);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    // spawn() returns immediately — the child runs in the background.
    // We intentionally don't .await the output to minimise latency.
    let _ = cmd.spawn();
}

/// Map an SDL keycode (as sent by main.rs `js_key_to_sdl_keycode`) to
/// an xdotool key name (X11 keysym name).
///
/// SDL keycodes for printable ASCII (32–126) are the character's ASCII
/// value.  Special keys use SDL's 0x4000_xxxx scan-code namespace.
fn sdl_keycode_to_xdotool(sdlk: i64) -> Option<String> {
    // ── Special keys (non-printable) ─────────────────────────────
    match sdlk {
        8 => return Some("BackSpace".into()),
        9 => return Some("Tab".into()),
        13 => return Some("Return".into()),
        27 => return Some("Escape".into()),
        127 => return Some("Delete".into()),
        _ => {}
    }

    // ── Printable ASCII ──────────────────────────────────────────
    if (32..=126).contains(&sdlk) {
        let ch = sdlk as u8 as char;
        // xdotool accepts single characters for most keys.
        // Special-case space because xdotool needs the name.
        if ch == ' ' {
            return Some("space".into());
        }
        return Some(ch.to_string());
    }

    // ── SDL extended keycodes (0x4000_xxxx) ──────────────────────
    let sdlk_u = sdlk as u64;
    match sdlk_u {
        // Function keys
        0x4000_003A => Some("F1".into()),
        0x4000_003B => Some("F2".into()),
        0x4000_003C => Some("F3".into()),
        0x4000_003D => Some("F4".into()),
        0x4000_003E => Some("F5".into()),
        0x4000_003F => Some("F6".into()),
        0x4000_0040 => Some("F7".into()),
        0x4000_0041 => Some("F8".into()),
        0x4000_0042 => Some("F9".into()),
        0x4000_0043 => Some("F10".into()),
        0x4000_0044 => Some("F11".into()),
        0x4000_0045 => Some("F12".into()),

        // Navigation
        0x4000_0049 => Some("Insert".into()),
        0x4000_004A => Some("Home".into()),
        0x4000_004B => Some("Prior".into()), // Page Up
        0x4000_004D => Some("End".into()),
        0x4000_004E => Some("Next".into()),  // Page Down

        // Arrow keys
        0x4000_004F => Some("Right".into()),
        0x4000_0050 => Some("Left".into()),
        0x4000_0051 => Some("Down".into()),
        0x4000_0052 => Some("Up".into()),

        // Lock keys
        0x4000_0039 => Some("Caps_Lock".into()),
        0x4000_0053 => Some("Num_Lock".into()),
        0x4000_0047 => Some("Scroll_Lock".into()),

        // Modifiers
        0x4000_00E0 => Some("Control_L".into()),
        0x4000_00E1 => Some("Shift_L".into()),
        0x4000_00E2 => Some("Alt_L".into()),
        0x4000_00E3 => Some("Super_L".into()),

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_keys() {
        assert_eq!(sdl_keycode_to_xdotool(97), Some("a".into()));
        assert_eq!(sdl_keycode_to_xdotool(65), Some("A".into()));
        assert_eq!(sdl_keycode_to_xdotool(49), Some("1".into()));
        assert_eq!(sdl_keycode_to_xdotool(32), Some("space".into()));
    }

    #[test]
    fn special_keys() {
        assert_eq!(sdl_keycode_to_xdotool(13), Some("Return".into()));
        assert_eq!(sdl_keycode_to_xdotool(27), Some("Escape".into()));
        assert_eq!(sdl_keycode_to_xdotool(8), Some("BackSpace".into()));
        assert_eq!(sdl_keycode_to_xdotool(9), Some("Tab".into()));
        assert_eq!(sdl_keycode_to_xdotool(127), Some("Delete".into()));
    }

    #[test]
    fn extended_keys() {
        // Arrow keys
        assert_eq!(sdl_keycode_to_xdotool(0x4000_004F), Some("Right".into()));
        assert_eq!(sdl_keycode_to_xdotool(0x4000_0052), Some("Up".into()));
        // F-keys
        assert_eq!(sdl_keycode_to_xdotool(0x4000_003A), Some("F1".into()));
        // Modifiers
        assert_eq!(sdl_keycode_to_xdotool(0x4000_00E1), Some("Shift_L".into()));
        assert_eq!(sdl_keycode_to_xdotool(0x4000_00E0), Some("Control_L".into()));
    }

    #[test]
    fn unknown_key_returns_none() {
        assert_eq!(sdl_keycode_to_xdotool(0), None);
        assert_eq!(sdl_keycode_to_xdotool(0x4000_FFFF), None);
    }
}
