// ============================================================
// PER-SESSION XVFB ALLOCATOR (Phase 12.6b)
// ============================================================
//
// Manages per-session Xvfb instances on dynamic display numbers
// (:100, :101, ...). Each supervisor session gets its own display
// so libraries that grab the X server exclusively (Qt, some GLFW
// configs) don't conflict with each other or with the worker's
// shared :99.
//
// LRU eviction: when the pool hits MAX_SESSIONS, the oldest
// inactive session's Xvfb is killed to free the display number.

use std::collections::HashMap;
use std::time::Instant;
use tokio::process::{Child, Command};

const DISPLAY_BASE: u32 = 100;
const MAX_SESSIONS: usize = 200;

#[derive(Debug)]
pub struct XvfbSession {
    pub display_num: u32,
    pub display_str: String,
    pub process: Child,
    pub created_at: Instant,
    pub last_used: Instant,
}

pub struct XvfbAllocator {
    sessions: HashMap<String, XvfbSession>,
    next_display: u32,
}

impl XvfbAllocator {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_display: DISPLAY_BASE,
        }
    }

    pub fn active_count(&self) -> usize {
        self.sessions.len()
    }

    /// Allocate a new Xvfb for the given session ID.
    /// Returns the display string (e.g. ":100") on success.
    pub async fn allocate(
        &mut self,
        session_id: &str,
        width: u32,
        height: u32,
    ) -> anyhow::Result<String> {
        if self.sessions.contains_key(session_id) {
            let session = self.sessions.get_mut(session_id).unwrap();
            session.last_used = Instant::now();
            return Ok(session.display_str.clone());
        }

        if self.sessions.len() >= MAX_SESSIONS {
            self.evict_oldest().await;
        }

        let display_num = self.next_display;
        self.next_display += 1;
        let display_str = format!(":{}", display_num);

        // Clean stale lock files
        let lock_file = format!("/tmp/.X11-unix/X{}", display_num);
        if std::path::Path::new(&lock_file).exists() {
            let _ = std::fs::remove_file(&lock_file);
        }
        let lock_tmp = format!("/tmp/.X{}-lock", display_num);
        if std::path::Path::new(&lock_tmp).exists() {
            let _ = std::fs::remove_file(&lock_tmp);
        }

        let process = Command::new("Xvfb")
            .arg(&display_str)
            .arg("-screen")
            .arg("0")
            .arg(format!("{}x{}x24", width, height))
            .arg("-ac")
            .arg("-nolisten")
            .arg("tcp")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;

        // Brief wait for Xvfb to start
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let now = Instant::now();
        self.sessions.insert(
            session_id.to_string(),
            XvfbSession {
                display_num,
                display_str: display_str.clone(),
                process,
                created_at: now,
                last_used: now,
            },
        );

        eprintln!(
            "[Xvfb] allocated display {} for session {} ({}/{} active)",
            display_str,
            session_id,
            self.sessions.len(),
            MAX_SESSIONS
        );

        Ok(display_str)
    }

    /// Get the display string for an existing session.
    pub fn get_display(&mut self, session_id: &str) -> Option<String> {
        self.sessions.get_mut(session_id).map(|s| {
            s.last_used = Instant::now();
            s.display_str.clone()
        })
    }

    /// Release a session's Xvfb.
    pub async fn release(&mut self, session_id: &str) {
        if let Some(mut session) = self.sessions.remove(session_id) {
            let _ = session.process.kill().await;
            eprintln!(
                "[Xvfb] released display {} for session {} ({} remaining)",
                session.display_str,
                session_id,
                self.sessions.len()
            );
        }
    }

    /// Evict the least recently used session.
    async fn evict_oldest(&mut self) {
        let oldest_key = self
            .sessions
            .iter()
            .min_by_key(|(_, s)| s.last_used)
            .map(|(k, _)| k.clone());

        if let Some(key) = oldest_key {
            eprintln!("[Xvfb] evicting LRU session {}", key);
            self.release(&key).await;
        }
    }

    /// Kill all active Xvfb sessions (cleanup on worker shutdown).
    pub async fn shutdown_all(&mut self) {
        let keys: Vec<String> = self.sessions.keys().cloned().collect();
        for key in keys {
            self.release(&key).await;
        }
    }
}

impl Default for XvfbAllocator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocator_starts_empty() {
        let alloc = XvfbAllocator::new();
        assert_eq!(alloc.active_count(), 0);
    }

    #[test]
    fn get_display_returns_none_for_unknown() {
        let mut alloc = XvfbAllocator::new();
        assert!(alloc.get_display("nonexistent").is_none());
    }
}
