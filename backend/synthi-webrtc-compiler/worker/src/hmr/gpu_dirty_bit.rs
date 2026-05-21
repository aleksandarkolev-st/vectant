// ============================================================
// GPU DIRTY BIT TRACKER (Phase 2 scaffold)
// ============================================================
//
// Spec: docs/GPU_HMR_ULTRAPLAN.md §6.1.2.
//
// The shadow arena (§6.1.1) covers the latency floor by keeping
// the snapshot copy in VRAM. The dirty-bit shim covers the
// *amount* of work — clean buffers don't need to be re-copied
// to the shadow on every swap, only those that the host runner
// has written into since the last sync.
//
// Phase 2 contract:
//
//   • Per-buffer dirty bits keyed by `CuDevicePtr` so the
//     tracker speaks the same key as `ShadowArena`.
//   • `mark(key, bytes)` — host runner calls this after every
//     kernel launch that wrote to `key`. `bytes` lets the
//     tracker maintain a running dirty-byte estimate for the
//     planner.
//   • `clear(key)` — called by the snapshot path after a
//     successful `sync_to_shadow`.
//   • `clear_all()` — called on a successful global save (Tier
//     A path or cold-restart fallthrough).
//   • `is_dirty(key)`, `dirty_count()`, `dirty_bytes()`,
//     `iter_dirty()` — introspection for the snapshot budget
//     decision.
//   • `with_baseline(known_buffers)` — bulk-register known
//     allocations as "clean" so the tracker doesn't report a
//     pristine buffer as dirty just because no-one marked it.
//
// The tracker holds zero driver state — pure in-memory
// bookkeeping — so it's the easiest Phase-2 module to unit-test.
//
// Feature-gated by `gpu-hmr`.

#![cfg(feature = "gpu-hmr")]

use std::collections::{HashMap, HashSet};

use crate::hmr::gpu_driver_loader::CuDevicePtr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirtyStats {
    pub dirty_buffers: usize,
    pub clean_buffers: usize,
    pub dirty_bytes: u64,
    pub tracked_bytes: u64,
}

impl DirtyStats {
    /// Fraction of *tracked* buffers that are currently dirty.
    /// Returns 0.0 if nothing is tracked yet (avoids NaN in
    /// telemetry).
    pub fn dirty_ratio(&self) -> f64 {
        let total = self.dirty_buffers + self.clean_buffers;
        if total == 0 {
            0.0
        } else {
            self.dirty_buffers as f64 / total as f64
        }
    }
}

/// Per-buffer dirty + size record. Phase 2 keeps the size on
/// the tracker rather than asking the caller to pass it in
/// every `clear()` so the snapshot path can compute the byte
/// budget without re-walking the buffer registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    bytes: u64,
    dirty: bool,
}

#[derive(Debug, Default)]
pub struct DirtyBitTracker {
    entries: HashMap<CuDevicePtr, Entry>,
    /// Bookkeeping for `iter_dirty`. Kept in sync with the
    /// `dirty` flag on each entry.
    dirty_set: HashSet<CuDevicePtr>,
    /// Monotonic count of `mark` calls — `dirty_bytes` only
    /// reflects the current snapshot, this surfaces frequency
    /// for telemetry.
    mark_calls: u64,
    /// Monotonic count of `clear` calls (both single and
    /// `clear_all` increments by however many entries were
    /// cleared).
    clear_calls: u64,
}

impl DirtyBitTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bulk-register a baseline of known buffers as clean.
    /// `bytes_of` may return None for buffers whose size is
    /// unknown — those are tracked with `bytes = 0` and still
    /// participate in dirty accounting.
    pub fn with_baseline(
        known_buffers: impl IntoIterator<Item = (CuDevicePtr, Option<u64>)>,
    ) -> Self {
        let mut t = Self::new();
        for (key, bytes) in known_buffers {
            t.entries.insert(
                key,
                Entry {
                    bytes: bytes.unwrap_or(0),
                    dirty: false,
                },
            );
        }
        t
    }

    pub fn track(&mut self, key: CuDevicePtr, bytes: u64) {
        let entry = self.entries.entry(key).or_insert(Entry {
            bytes: 0,
            dirty: false,
        });
        entry.bytes = bytes;
    }

    pub fn mark(&mut self, key: CuDevicePtr, bytes: u64) {
        self.mark_calls += 1;
        let entry = self.entries.entry(key).or_insert(Entry {
            bytes: 0,
            dirty: false,
        });
        // Only update bytes if the caller actually provided a
        // size; passing 0 must not erase a previously-known
        // allocation size.
        if bytes > 0 {
            entry.bytes = bytes;
        }
        entry.dirty = true;
        self.dirty_set.insert(key);
    }

    pub fn clear(&mut self, key: CuDevicePtr) -> bool {
        if let Some(entry) = self.entries.get_mut(&key) {
            if entry.dirty {
                entry.dirty = false;
                self.dirty_set.remove(&key);
                self.clear_calls += 1;
                return true;
            }
        }
        false
    }

    pub fn clear_all(&mut self) -> usize {
        let cleared = self.dirty_set.len();
        for key in self.dirty_set.drain() {
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.dirty = false;
            }
        }
        self.clear_calls += cleared as u64;
        cleared
    }

    pub fn forget(&mut self, key: CuDevicePtr) -> bool {
        let had = self.entries.remove(&key).is_some();
        self.dirty_set.remove(&key);
        had
    }

    pub fn is_dirty(&self, key: CuDevicePtr) -> bool {
        self.entries.get(&key).map(|e| e.dirty).unwrap_or(false)
    }

    pub fn is_tracked(&self, key: CuDevicePtr) -> bool {
        self.entries.contains_key(&key)
    }

    pub fn dirty_count(&self) -> usize {
        self.dirty_set.len()
    }

    pub fn tracked_count(&self) -> usize {
        self.entries.len()
    }

    pub fn dirty_bytes(&self) -> u64 {
        self.dirty_set
            .iter()
            .filter_map(|k| self.entries.get(k).map(|e| e.bytes))
            .sum()
    }

    pub fn tracked_bytes(&self) -> u64 {
        self.entries.values().map(|e| e.bytes).sum()
    }

    pub fn mark_calls(&self) -> u64 {
        self.mark_calls
    }

    pub fn clear_calls(&self) -> u64 {
        self.clear_calls
    }

    pub fn iter_dirty(&self) -> impl Iterator<Item = (CuDevicePtr, u64)> + '_ {
        self.dirty_set
            .iter()
            .filter_map(|k| self.entries.get(k).map(|e| (*k, e.bytes)))
    }

    pub fn stats(&self) -> DirtyStats {
        let dirty_buffers = self.dirty_set.len();
        let clean_buffers = self.entries.len().saturating_sub(dirty_buffers);
        DirtyStats {
            dirty_buffers,
            clean_buffers,
            dirty_bytes: self.dirty_bytes(),
            tracked_bytes: self.tracked_bytes(),
        }
    }
}

// ── Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_tracker_is_empty() {
        let t = DirtyBitTracker::new();
        assert_eq!(t.dirty_count(), 0);
        assert_eq!(t.tracked_count(), 0);
        assert_eq!(t.dirty_bytes(), 0);
        assert_eq!(t.tracked_bytes(), 0);
        assert!(!t.is_dirty(0xa000));
        assert!(!t.is_tracked(0xa000));
    }

    #[test]
    fn with_baseline_seeds_clean_entries() {
        let t = DirtyBitTracker::with_baseline(vec![
            (0xa000, Some(4096)),
            (0xb000, Some(8192)),
            (0xc000, None),
        ]);
        assert_eq!(t.tracked_count(), 3);
        assert_eq!(t.dirty_count(), 0);
        assert_eq!(t.tracked_bytes(), 4096 + 8192);
        assert!(!t.is_dirty(0xa000));
        assert!(t.is_tracked(0xa000));
        assert!(t.is_tracked(0xc000));
    }

    #[test]
    fn mark_sets_dirty_and_records_bytes() {
        let mut t = DirtyBitTracker::new();
        t.mark(0xa000, 4096);
        assert!(t.is_dirty(0xa000));
        assert!(t.is_tracked(0xa000));
        assert_eq!(t.dirty_count(), 1);
        assert_eq!(t.dirty_bytes(), 4096);
        assert_eq!(t.mark_calls(), 1);
    }

    #[test]
    fn mark_with_zero_bytes_preserves_existing_size() {
        let mut t = DirtyBitTracker::new();
        t.mark(0xa000, 4096);
        // Subsequent mark with 0 must not zero the size.
        t.mark(0xa000, 0);
        assert_eq!(t.dirty_bytes(), 4096);
        assert_eq!(t.mark_calls(), 2);
    }

    #[test]
    fn clear_returns_true_only_when_was_dirty() {
        let mut t = DirtyBitTracker::new();
        t.mark(0xa000, 4096);
        assert!(t.clear(0xa000));
        // Second clear is a no-op.
        assert!(!t.clear(0xa000));
        // Unknown key returns false.
        assert!(!t.clear(0xdead));
        assert_eq!(t.dirty_count(), 0);
        assert!(!t.is_dirty(0xa000));
        // Entry still tracked, just clean.
        assert!(t.is_tracked(0xa000));
        assert_eq!(t.clear_calls(), 1);
    }

    #[test]
    fn clear_all_drains_dirty_set() {
        let mut t = DirtyBitTracker::new();
        t.mark(0xa000, 4096);
        t.mark(0xb000, 8192);
        t.mark(0xc000, 1024);
        assert_eq!(t.dirty_count(), 3);
        let cleared = t.clear_all();
        assert_eq!(cleared, 3);
        assert_eq!(t.dirty_count(), 0);
        assert_eq!(t.dirty_bytes(), 0);
        // Clean entries stay tracked.
        assert!(t.is_tracked(0xa000));
        assert_eq!(t.clear_calls(), 3);
    }

    #[test]
    fn dirty_bytes_sum_only_dirty_entries() {
        let mut t = DirtyBitTracker::with_baseline(vec![
            (0xa000, Some(4096)),
            (0xb000, Some(8192)),
            (0xc000, Some(1024)),
        ]);
        assert_eq!(t.dirty_bytes(), 0);
        assert_eq!(t.tracked_bytes(), 4096 + 8192 + 1024);
        t.mark(0xb000, 8192);
        t.mark(0xc000, 1024);
        assert_eq!(t.dirty_bytes(), 8192 + 1024);
        assert_eq!(t.tracked_bytes(), 4096 + 8192 + 1024);
    }

    #[test]
    fn iter_dirty_visits_only_dirty_entries() {
        let mut t =
            DirtyBitTracker::with_baseline(vec![(0xa000, Some(4096)), (0xb000, Some(8192))]);
        t.mark(0xa000, 4096);
        let mut items: Vec<_> = t.iter_dirty().collect();
        items.sort();
        assert_eq!(items, vec![(0xa000u64, 4096u64)]);
        t.mark(0xb000, 8192);
        let mut items: Vec<_> = t.iter_dirty().collect();
        items.sort();
        assert_eq!(items, vec![(0xa000u64, 4096u64), (0xb000u64, 8192u64)]);
    }

    #[test]
    fn forget_removes_entry_entirely() {
        let mut t = DirtyBitTracker::new();
        t.mark(0xa000, 4096);
        assert!(t.forget(0xa000));
        assert!(!t.is_tracked(0xa000));
        assert!(!t.is_dirty(0xa000));
        assert_eq!(t.tracked_count(), 0);
        assert!(!t.forget(0xdead));
    }

    #[test]
    fn track_seeds_an_entry_as_clean() {
        let mut t = DirtyBitTracker::new();
        t.track(0xa000, 4096);
        assert!(t.is_tracked(0xa000));
        assert!(!t.is_dirty(0xa000));
        assert_eq!(t.tracked_bytes(), 4096);
        // Subsequent mark must keep the size, not overwrite with 0.
        t.mark(0xa000, 0);
        assert_eq!(t.dirty_bytes(), 4096);
    }

    #[test]
    fn stats_reports_dirty_ratio_no_nan() {
        let t = DirtyBitTracker::new();
        let s = t.stats();
        assert_eq!(s.dirty_buffers, 0);
        assert_eq!(s.clean_buffers, 0);
        assert!(s.dirty_ratio().is_finite());
        assert_eq!(s.dirty_ratio(), 0.0);

        let mut t = DirtyBitTracker::with_baseline(vec![
            (0xa000, Some(4)),
            (0xb000, Some(4)),
            (0xc000, Some(4)),
            (0xd000, Some(4)),
        ]);
        t.mark(0xa000, 4);
        let s = t.stats();
        assert_eq!(s.dirty_buffers, 1);
        assert_eq!(s.clean_buffers, 3);
        assert!((s.dirty_ratio() - 0.25).abs() < 1e-9);
    }

    #[test]
    fn tracker_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DirtyBitTracker>();
        assert_send_sync::<DirtyStats>();
    }
}
