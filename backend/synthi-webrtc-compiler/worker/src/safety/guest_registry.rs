//! Guest-process registry — records root PID + binary fingerprint for
//! every spawned guest runner.
//!
//! Prerequisites for:
//!   - Window-tree-aware focus lock (ultraplan §Security). Needs to know
//!     which guest process tree is "ours" so input dispatch can be gated
//!     on the focused window belonging to a descendant of that tree.
//!   - WM_CLASS spoof check (ultraplan §Security v4). Needs a hash of
//!     `/proc/<pid>/exe` so we can cross-check whether a window's
//!     declared `WM_CLASS` matches the binary the worker actually
//!     launched.
//!
//! Phase 1 is passive — the registry records state, exposes query
//! helpers, and emits `wm_class_mismatch` / `focus_lost` events when a
//! consumer asks for a verdict. Gating the input dispatch path is a
//! follow-up (see §Input-dispatch focus lock integration).
//!
//! Linux-only today (reads `/proc/<pid>/*`). Non-Linux hosts get a
//! fallback that records the PID but skips fingerprinting.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Instant;

use lazy_static::lazy_static;
use sha2::{Digest, Sha256};

lazy_static! {
    /// Process-wide singleton. Cheap reads, infrequent writes (one per
    /// guest spawn). Exposed directly so the runner + input-dispatch
    /// paths can register / query without threading an Arc through.
    pub static ref GLOBAL_GUEST_REGISTRY: GuestRegistry = GuestRegistry::new();
}

/// One guest runner's metadata. Keyed by `session_id` in the registry.
#[derive(Debug, Clone)]
pub struct GuestInfo {
    /// PID of the process the worker spawned directly. Not necessarily
    /// the PID of the eventual window owner — the runner can fork
    /// children (dlopen'd modules spawning threads are common). The
    /// focus-lock check walks the process tree from this root.
    pub root_pid: u32,

    /// When the process was spawned. Used to age out stale registry
    /// entries when a session crashes without a clean teardown.
    pub started_at: Instant,

    /// Resolved exec path (`/proc/<pid>/exe` target). Empty on non-Linux
    /// or if the process exited before we could read it.
    pub binary_path: Option<PathBuf>,

    /// SHA-256 hex of the binary file content. Empty when `binary_path`
    /// is None or the file isn't readable. Used by the WM_CLASS spoof
    /// check: a window claiming `WM_CLASS=code` gets cross-checked by
    /// reading `/proc/<window_pid>/exe` and comparing hashes against
    /// this registry — a mismatch → spoof.
    pub binary_fingerprint: Option<String>,

    /// argv[0] as the guest declared it. Not authoritative — the guest
    /// can lie. Stored for triage.
    pub argv0: Option<String>,

    /// Expected WM_CLASS. Phase 1: derived from the binary basename.
    /// A guest renaming its binary to "code" will match; that's fine —
    /// the fingerprint check is what catches the actual spoof (since a
    /// renamed binary still has a distinct content hash from the real
    /// `/usr/bin/code`).
    pub expected_wm_class_hint: Option<String>,
}

/// Snapshot returned by `registry_snapshot()` for serialization to
/// event-log / admin endpoints. Times are serialized as epoch ms.
#[derive(Debug, Clone)]
pub struct GuestInfoSnapshot {
    pub session_id: String,
    pub root_pid: u32,
    pub started_at_ms: u64,
    pub binary_path: Option<String>,
    pub binary_fingerprint: Option<String>,
    pub argv0: Option<String>,
    pub expected_wm_class_hint: Option<String>,
}

/// Result of a WM_CLASS spoof check. See `check_wm_class_match`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WmClassVerdict {
    /// Window's `/proc/<pid>/exe` matches the registry fingerprint for
    /// that session. Safe to classify based on WM_CLASS.
    Match,
    /// Hash of `/proc/<pid>/exe` differs from the registered fingerprint
    /// for the session's root PID. Fall back to conservative
    /// classification and emit `wm_class_mismatch`.
    Mismatch { claimed: String, registry_binary: Option<String> },
    /// Registry has no entry for the window's owning session — can't
    /// make a verdict. Callers treat this as "unknown" (don't emit
    /// mismatch).
    Unknown,
    /// Couldn't read `/proc/<pid>/exe` at check time (process exited,
    /// permission denied, non-Linux). Conservative fallback — don't
    /// crash, don't treat as mismatch.
    Unavailable { reason: String },
}

/// In-process registry. Cheap to clone (keyed by Arc<RwLock<...>>).
pub struct GuestRegistry {
    entries: RwLock<HashMap<String, GuestInfo>>,
}

impl Default for GuestRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl GuestRegistry {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
        }
    }

    /// Register a freshly-spawned guest. Attempts to resolve
    /// `/proc/<pid>/exe` + fingerprint synchronously; if either fails
    /// the entry is still recorded with the fields as `None` so the
    /// focus-lock code has at least the root PID to walk.
    pub fn register(&self, session_id: &str, root_pid: u32, argv0: Option<String>) -> GuestInfo {
        let (binary_path, binary_fingerprint) = resolve_binary(root_pid);
        let expected_hint = binary_path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        let info = GuestInfo {
            root_pid,
            started_at: Instant::now(),
            binary_path,
            binary_fingerprint,
            argv0,
            expected_wm_class_hint: expected_hint,
        };
        let mut guard = self.entries.write().expect("guest_registry poisoned");
        guard.insert(session_id.to_string(), info.clone());
        info
    }

    /// Remove a session's entry on teardown. Idempotent.
    pub fn unregister(&self, session_id: &str) -> Option<GuestInfo> {
        let mut guard = self.entries.write().expect("guest_registry poisoned");
        guard.remove(session_id)
    }

    /// Fetch a session's info snapshot.
    pub fn get(&self, session_id: &str) -> Option<GuestInfo> {
        let guard = self.entries.read().expect("guest_registry poisoned");
        guard.get(session_id).cloned()
    }

    pub fn snapshot(&self) -> Vec<GuestInfoSnapshot> {
        let guard = self.entries.read().expect("guest_registry poisoned");
        let now = Instant::now();
        let boot_wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        guard
            .iter()
            .map(|(sid, info)| GuestInfoSnapshot {
                session_id: sid.clone(),
                root_pid: info.root_pid,
                started_at_ms: boot_wall
                    .saturating_sub(now.duration_since(info.started_at).as_millis() as u64),
                binary_path: info.binary_path.as_ref().map(|p| p.display().to_string()),
                binary_fingerprint: info.binary_fingerprint.clone(),
                argv0: info.argv0.clone(),
                expected_wm_class_hint: info.expected_wm_class_hint.clone(),
            })
            .collect()
    }

    /// Cross-check a window's declared WM_CLASS against the fingerprint
    /// registered for the session the window belongs to. See
    /// `WmClassVerdict` for the interpretation of each variant.
    ///
    /// `window_pid` is the PID reported by the X server for the focused
    /// window (via `_NET_WM_PID`). If it's `None` the verdict is
    /// `Unknown` — some toolkits don't set it.
    pub fn check_wm_class_match(
        &self,
        session_id: &str,
        window_pid: Option<u32>,
        claimed_wm_class: &str,
    ) -> WmClassVerdict {
        let info = match self.get(session_id) {
            Some(i) => i,
            None => return WmClassVerdict::Unknown,
        };
        let Some(pid) = window_pid else {
            return WmClassVerdict::Unknown;
        };
        // Descendant check: the focused window's PID must belong to the
        // guest's process tree rooted at info.root_pid. A match by PID
        // == root_pid is the common case; descendants are acceptable
        // for toolkits that fork helpers.
        if !is_descendant_of(pid, info.root_pid) && pid != info.root_pid {
            return WmClassVerdict::Mismatch {
                claimed: claimed_wm_class.to_string(),
                registry_binary: info
                    .binary_path
                    .as_ref()
                    .map(|p| p.display().to_string()),
            };
        }
        let window_binary_hash = match read_proc_exe_fingerprint(pid) {
            Ok(Some(h)) => h,
            Ok(None) => {
                return WmClassVerdict::Unavailable {
                    reason: "proc_exe_unreadable".to_string(),
                };
            }
            Err(e) => {
                return WmClassVerdict::Unavailable { reason: e.to_string() };
            }
        };
        match &info.binary_fingerprint {
            None => WmClassVerdict::Unavailable {
                reason: "registry_missing_fingerprint".to_string(),
            },
            Some(expected) if expected == &window_binary_hash => WmClassVerdict::Match,
            Some(_) => WmClassVerdict::Mismatch {
                claimed: claimed_wm_class.to_string(),
                registry_binary: info
                    .binary_path
                    .as_ref()
                    .map(|p| p.display().to_string()),
            },
        }
    }
}

// ─── Linux /proc helpers ───────────────────────────────────────────────

fn resolve_binary(pid: u32) -> (Option<PathBuf>, Option<String>) {
    let exe_link = format!("/proc/{}/exe", pid);
    match std::fs::read_link(&exe_link) {
        Ok(path) => {
            let fp = fingerprint_file(&path).ok().flatten();
            (Some(path), fp)
        }
        Err(_) => (None, None),
    }
}

fn read_proc_exe_fingerprint(pid: u32) -> io::Result<Option<String>> {
    let exe_link = format!("/proc/{}/exe", pid);
    match std::fs::read_link(&exe_link) {
        Ok(path) => fingerprint_file(&path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn fingerprint_file(path: &Path) -> io::Result<Option<String>> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(Some(format!("{:x}", digest)))
}

/// Walk `/proc/<pid>/stat` PPIDs until `target` is reached or the tree
/// bottoms out at init. Returns true when `target` is an ancestor of
/// `candidate`. Self-comparison returns false.
///
/// Non-Linux / missing /proc → returns false (focus lock falls back to
/// conservative behaviour upstream).
pub fn is_descendant_of(candidate: u32, target: u32) -> bool {
    if candidate == target {
        return false;
    }
    let mut current = candidate;
    // Bound the walk defensively — the deepest realistic process tree
    // is <100 levels; 256 is a generous guard against cycles from
    // corrupted /proc.
    for _ in 0..256 {
        let parent = match read_ppid(current) {
            Some(p) => p,
            None => return false,
        };
        if parent == target {
            return true;
        }
        if parent == 0 || parent == 1 || parent == current {
            return false;
        }
        current = parent;
    }
    false
}

fn read_proc_status_field(pid: u32, field: &str) -> Option<String> {
    let path = format!("/proc/{}/status", pid);
    let contents = std::fs::read_to_string(&path).ok()?;
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{}:\t", field)) {
            return Some(rest.to_string());
        }
        if let Some(rest) = line.strip_prefix(&format!("{}: ", field)) {
            return Some(rest.to_string());
        }
    }
    None
}

fn read_ppid(pid: u32) -> Option<u32> {
    read_proc_status_field(pid, "PPid").and_then(|s| s.trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_descendant_of_self_returns_false() {
        assert!(!is_descendant_of(1, 1));
    }

    #[test]
    fn fingerprint_nonexistent_returns_ok_none() {
        let fp = fingerprint_file(Path::new("/nonexistent/path/that/should/not/exist"));
        assert!(matches!(fp, Ok(None)));
    }

    #[test]
    fn register_stores_and_retrieves() {
        let reg = GuestRegistry::new();
        let info = reg.register("test-session", std::process::id(), Some("worker".to_string()));
        assert_eq!(info.root_pid, std::process::id());
        let fetched = reg.get("test-session").expect("entry not found");
        assert_eq!(fetched.root_pid, info.root_pid);
    }

    #[test]
    fn unregister_removes() {
        let reg = GuestRegistry::new();
        reg.register("s1", 42, None);
        assert!(reg.get("s1").is_some());
        reg.unregister("s1");
        assert!(reg.get("s1").is_none());
    }

    #[test]
    fn check_wm_class_unknown_session() {
        let reg = GuestRegistry::new();
        let verdict = reg.check_wm_class_match("missing", Some(1), "code");
        assert_eq!(verdict, WmClassVerdict::Unknown);
    }

    #[test]
    fn check_wm_class_missing_window_pid_is_unknown() {
        let reg = GuestRegistry::new();
        reg.register("s1", std::process::id(), None);
        let verdict = reg.check_wm_class_match("s1", None, "code");
        assert_eq!(verdict, WmClassVerdict::Unknown);
    }
}
