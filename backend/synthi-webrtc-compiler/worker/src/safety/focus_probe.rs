//! Focus probe — periodically samples the X11 active-window on the
//! worker-managed display and caches the result so the input-dispatch
//! path can consult `(focused_window_pid, wm_class, window_title)`
//! without per-event subprocess overhead.
//!
//! Phase 1 is advisory: consumers query the cache + emit a `security`
//! event on a mismatch but do NOT gate input dispatch. Gating is phase
//! 2c (ultraplan §Security + §Arbitration).
//!
//! Uses `xdotool` + `xprop` which are already available in the worker
//! image (see `Dockerfile`). The probe runs one task per DISPLAY (one
//! Xvfb per session), not per-event. Polling cadence is 500ms by
//! default — fast enough to track meaningful focus changes, slow
//! enough to stay invisible in `top`.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use lazy_static::lazy_static;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::safety::guest_registry::{WmClassVerdict, GLOBAL_GUEST_REGISTRY};

/// Snapshot of the focused window at a point in time.
#[derive(Debug, Clone)]
pub struct FocusInfo {
    pub window_id: String,
    pub window_pid: Option<u32>,
    pub wm_class: Option<String>,
    pub window_title: Option<String>,
    pub observed_at: Instant,
}

/// Keyed by DISPLAY string (":99", ":100", ...). Each active display
/// owns at most one probe task; the cache entry is replaced on every
/// tick.
#[derive(Debug, Clone)]
struct CacheEntry {
    focus: FocusInfo,
}

lazy_static! {
    static ref FOCUS_CACHE: RwLock<HashMap<String, CacheEntry>> = RwLock::new(HashMap::new());
    static ref ACTIVE_PROBES: Mutex<HashMap<String, JoinHandle<()>>> = Mutex::new(HashMap::new());
    /// session_id -> DISPLAY so the gui-event handler in main.rs can
    /// resolve which probe to query without threading DISPLAY through.
    static ref SESSION_DISPLAY: RwLock<HashMap<String, String>> = RwLock::new(HashMap::new());
}

/// Bind a session id to the display it's running on. Called from the
/// runner once DISPLAY has been resolved. Overwrites on re-bind.
pub fn bind_session_display(session_id: &str, display: &str) {
    let mut guard = SESSION_DISPLAY.write().expect("session_display poisoned");
    guard.insert(session_id.to_string(), display.to_string());
}

pub fn unbind_session_display(session_id: &str) {
    let mut guard = SESSION_DISPLAY.write().expect("session_display poisoned");
    guard.remove(session_id);
}

pub fn display_for_session(session_id: &str) -> Option<String> {
    let guard = SESSION_DISPLAY.read().expect("session_display poisoned");
    guard.get(session_id).cloned()
}

/// Start a probe for the given display. Idempotent — if a probe is
/// already running, returns without spawning a second one.
pub async fn ensure_probe(display: &str) {
    let mut guard = ACTIVE_PROBES.lock().await;
    if guard.contains_key(display) {
        return;
    }
    let display = display.to_string();
    let display_for_task = display.clone();
    let handle = tokio::spawn(async move {
        probe_loop(display_for_task).await;
    });
    guard.insert(display, handle);
}

/// Stop a probe + drop its cache entry on session teardown.
pub async fn stop_probe(display: &str) {
    let handle = {
        let mut guard = ACTIVE_PROBES.lock().await;
        guard.remove(display)
    };
    if let Some(h) = handle {
        h.abort();
    }
    let mut cache = FOCUS_CACHE.write().expect("focus_cache poisoned");
    cache.remove(display);
}

/// Latest focus snapshot for a given DISPLAY. Returns `None` when the
/// probe hasn't produced a first sample yet.
pub fn current_focus(display: &str) -> Option<FocusInfo> {
    let cache = FOCUS_CACHE.read().expect("focus_cache poisoned");
    cache.get(display).map(|e| e.focus.clone())
}

/// Cross-check the cached focus against the guest registry. See
/// `GuestRegistry::check_wm_class_match` for the verdict semantics.
/// Returns `(verdict, focus_at_check_time)` so the caller can log
/// useful context on a mismatch.
pub fn verify_focus(session_id: &str, display: &str) -> (WmClassVerdict, Option<FocusInfo>) {
    let focus = current_focus(display);
    let verdict = match &focus {
        Some(f) => GLOBAL_GUEST_REGISTRY.check_wm_class_match(
            session_id,
            f.window_pid,
            f.wm_class.as_deref().unwrap_or(""),
        ),
        None => WmClassVerdict::Unavailable { reason: "no_focus_sample_yet".to_string() },
    };
    (verdict, focus)
}

const POLL_INTERVAL: Duration = Duration::from_millis(500);

async fn probe_loop(display: String) {
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    // Skip the first tick — the runner + WM take ~1s to come up;
    // sampling before then returns garbage.
    interval.tick().await;
    loop {
        interval.tick().await;
        match probe_once(&display).await {
            Ok(focus) => {
                let mut cache = FOCUS_CACHE.write().expect("focus_cache poisoned");
                cache.insert(display.clone(), CacheEntry { focus });
            }
            Err(_) => {
                // Silent — probe failures are common while Xvfb is
                // still warming or when the session is between runs.
                // Don't log on every tick; the structured-logger path
                // catches higher-signal events.
            }
        }
    }
}

async fn run_xdotool(display: &str, args: &[&str]) -> Result<String, std::io::Error> {
    let out = Command::new("xdotool")
        .env("DISPLAY", display)
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "xdotool {:?} exited with {:?}",
                args, out.status.code()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn probe_once(display: &str) -> Result<FocusInfo, std::io::Error> {
    let window_id = run_xdotool(display, &["getactivewindow"]).await?;
    if window_id.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "empty_window_id",
        ));
    }
    let window_pid = run_xdotool(display, &["getwindowpid", &window_id])
        .await
        .ok()
        .and_then(|s| s.parse::<u32>().ok());
    let wm_class = run_xdotool(display, &["getwindowclassname", &window_id])
        .await
        .ok()
        .filter(|s| !s.is_empty());
    let window_title = run_xdotool(display, &["getwindowname", &window_id])
        .await
        .ok()
        .filter(|s| !s.is_empty());
    Ok(FocusInfo {
        window_id,
        window_pid,
        wm_class,
        window_title,
        observed_at: Instant::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_focus_returns_none_without_sample() {
        let focus = current_focus(":999");
        assert!(focus.is_none());
    }

    #[test]
    fn verify_focus_without_sample_is_unavailable() {
        let (verdict, focus) = verify_focus("missing-session", ":999");
        assert!(focus.is_none());
        match verdict {
            WmClassVerdict::Unavailable { reason } => {
                assert_eq!(reason, "no_focus_sample_yet");
            }
            other => panic!("unexpected verdict: {:?}", other),
        }
    }
}
