//! Worker-side input lease registry — phase 2c.
//!
//! Companion to the MCP's `arbitration/lease.ts`. The MCP registry
//! enforces single-holder within one MCP process; this one enforces
//! single-holder across every peer attached to the session — the
//! load-bearing guard that makes the lease contract real when two
//! independent clients (human browser + mcp-agent) are both connected.
//!
//! Semantics:
//!
//! * `acquire(peer_id, role, ms)` mints a lease. Observers never hold
//!   leases (defense-in-depth — the MCP's browser/observer split
//!   should already restrict this client-side). When a lease is
//!   already held by a different peer, acquire returns
//!   [`AcquireError::AlreadyHeld`] unless the caller passes
//!   `takeover = true`.
//! * `gate_dispatch(peer_id)` answers whether a peer may dispatch
//!   an input event right now. Called on the `gui-event` hot path
//!   before input translation.
//! * `release(lease_id)` drops a lease by id. No-op on unknown id.
//! * `evict_expired()` sweeps expired leases. Called lazily on every
//!   public method so a long-idle worker doesn't keep surfacing a
//!   stale lease.
//!
//! Not wired into `main.rs` signal loop yet — that's the follow-up the
//! phase-2c landing does. Primitive is unit-tested so the integration
//! can trust the contract.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use crate::webrtc::peer_registry::PeerRole;

/// Minimum lease duration. Anything shorter is clamped up so callers
/// can't churn the registry with microsecond leases.
pub const MIN_LEASE_MS: u64 = 50;

/// Maximum lease duration. Mirrors the MCP-side 10-minute cap.
pub const MAX_LEASE_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputLease {
    pub lease_id: String,
    pub peer_id: String,
    pub acquired_at: Instant,
    pub expires_at: Instant,
    pub lease_ms: u64,
}

impl InputLease {
    pub fn is_expired(&self, now: Instant) -> bool {
        self.expires_at <= now
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AcquireError {
    /// Another peer currently holds the lease and the caller didn't pass
    /// `takeover`.
    AlreadyHeld { current: InputLease },
    /// The calling peer's role doesn't permit holding a lease.
    RoleNotPermitted { role: PeerRole },
}

#[derive(Debug, PartialEq, Eq)]
pub enum GateDecision {
    /// Caller may dispatch input.
    Allowed,
    /// Another peer holds the lease — dispatch is rejected.
    Blocked { current: InputLease },
}

/// Thread-safe lease registry. Cheap to clone via `Arc<InputLeaseRegistry>`
/// in the worker's per-session state.
#[derive(Default)]
pub struct InputLeaseRegistry {
    inner: RwLock<Option<InputLease>>,
}

impl InputLeaseRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attempt to take the lease. See [`AcquireError`] for rejection
    /// shapes.
    pub fn acquire(
        &self,
        peer_id: &str,
        role: PeerRole,
        lease_ms: u64,
        takeover: bool,
    ) -> Result<InputLease, AcquireError> {
        if matches!(role, PeerRole::Observer) {
            return Err(AcquireError::RoleNotPermitted { role });
        }
        let ms = lease_ms.clamp(MIN_LEASE_MS, MAX_LEASE_MS);
        let now = Instant::now();
        let mut guard = self.inner.write().expect("input lease registry poisoned");
        if let Some(current) = guard.as_ref() {
            if !current.is_expired(now) && current.peer_id != peer_id && !takeover {
                return Err(AcquireError::AlreadyHeld {
                    current: current.clone(),
                });
            }
        }
        let lease = InputLease {
            lease_id: format!("worker_lease_{}", lease_id_suffix(now, peer_id)),
            peer_id: peer_id.to_string(),
            acquired_at: now,
            expires_at: now + Duration::from_millis(ms),
            lease_ms: ms,
        };
        *guard = Some(lease.clone());
        Ok(lease)
    }

    /// Release a lease by id. Returns `true` when a live matching lease
    /// was dropped.
    pub fn release(&self, lease_id: &str) -> bool {
        let mut guard = self.inner.write().expect("input lease registry poisoned");
        match guard.as_ref() {
            Some(current) if current.lease_id == lease_id => {
                *guard = None;
                true
            }
            _ => false,
        }
    }

    /// Release whatever lease is currently held. Used on peer disconnect
    /// so a vanished peer doesn't keep blocking the session.
    pub fn release_peer(&self, peer_id: &str) -> bool {
        let mut guard = self.inner.write().expect("input lease registry poisoned");
        match guard.as_ref() {
            Some(current) if current.peer_id == peer_id => {
                *guard = None;
                true
            }
            _ => false,
        }
    }

    /// Snapshot the current lease if any, sweeping expiry first.
    pub fn current_lease(&self) -> Option<InputLease> {
        let now = Instant::now();
        let mut guard = self.inner.write().expect("input lease registry poisoned");
        if let Some(current) = guard.as_ref() {
            if current.is_expired(now) {
                *guard = None;
                return None;
            }
        }
        guard.clone()
    }

    /// Decide whether `peer_id` may dispatch an input event right now.
    /// Hot-path gate; called once per `gui-event` on the worker.
    pub fn gate_dispatch(&self, peer_id: &str) -> GateDecision {
        match self.current_lease() {
            None => GateDecision::Allowed,
            Some(current) if current.peer_id == peer_id => GateDecision::Allowed,
            Some(current) => GateDecision::Blocked { current },
        }
    }
}

fn lease_id_suffix(now: Instant, peer_id: &str) -> String {
    // Stable-ish id without pulling uuid as a new dep. Monotonic-clock
    // nanos + peer-id hash, base36-encoded for a compact representation.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    peer_id.hash(&mut hasher);
    let nanos_hash = now.elapsed().as_nanos() as u64 ^ hasher.finish();
    format!("{:x}", nanos_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_mints_a_lease_for_browser() {
        let reg = InputLeaseRegistry::new();
        let lease = reg
            .acquire("b1", PeerRole::Browser, 5_000, false)
            .expect("ok");
        assert_eq!(lease.peer_id, "b1");
        assert_eq!(lease.lease_ms, 5_000);
    }

    #[test]
    fn acquire_rejects_observer_role() {
        let reg = InputLeaseRegistry::new();
        let err = reg
            .acquire("o1", PeerRole::Observer, 1_000, false)
            .expect_err("observer should be rejected");
        assert!(matches!(err, AcquireError::RoleNotPermitted { .. }));
    }

    #[test]
    fn second_acquire_without_takeover_is_rejected() {
        let reg = InputLeaseRegistry::new();
        reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        let err = reg
            .acquire("b2", PeerRole::Browser, 5_000, false)
            .expect_err("second acquire without takeover should fail");
        assert!(matches!(err, AcquireError::AlreadyHeld { .. }));
    }

    #[test]
    fn takeover_replaces_previous_holder() {
        let reg = InputLeaseRegistry::new();
        let first = reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        let second = reg.acquire("m1", PeerRole::McpAgent, 5_000, true).unwrap();
        assert_ne!(first.lease_id, second.lease_id);
        let current = reg.current_lease().unwrap();
        assert_eq!(current.peer_id, "m1");
    }

    #[test]
    fn gate_dispatch_allows_holder_and_blocks_others() {
        let reg = InputLeaseRegistry::new();
        reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        assert_eq!(reg.gate_dispatch("b1"), GateDecision::Allowed);
        match reg.gate_dispatch("o1") {
            GateDecision::Blocked { current } => assert_eq!(current.peer_id, "b1"),
            other => panic!("expected Blocked, got {:?}", other),
        }
    }

    #[test]
    fn release_by_id_drops_the_matching_lease() {
        let reg = InputLeaseRegistry::new();
        let lease = reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        assert!(reg.release(&lease.lease_id));
        assert!(reg.current_lease().is_none());
    }

    #[test]
    fn release_peer_drops_matching_holder_only() {
        let reg = InputLeaseRegistry::new();
        reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        assert!(!reg.release_peer("other"));
        assert!(reg.release_peer("b1"));
        assert!(reg.current_lease().is_none());
    }

    #[test]
    fn expired_lease_is_swept_on_read() {
        let reg = InputLeaseRegistry::new();
        reg.acquire("b1", PeerRole::Browser, MIN_LEASE_MS, false)
            .unwrap();
        std::thread::sleep(Duration::from_millis(MIN_LEASE_MS + 20));
        assert!(reg.current_lease().is_none());
        // Immediately acquireable again by anyone.
        reg.acquire("b2", PeerRole::Browser, 1_000, false).unwrap();
    }

    #[test]
    fn same_peer_reacquire_refreshes_without_takeover() {
        let reg = InputLeaseRegistry::new();
        let first = reg.acquire("b1", PeerRole::Browser, 1_000, false).unwrap();
        // Re-acquiring from the same holder mints a new lease id but
        // doesn't return AlreadyHeld — same-peer calls refresh the lease
        // rather than blocking.
        let second = reg.acquire("b1", PeerRole::Browser, 5_000, false).unwrap();
        assert_ne!(first.lease_id, second.lease_id);
        assert_eq!(second.peer_id, "b1");
    }
}
