// ============================================================
// INCREMENTAL CACHE WRITER
// ============================================================
// Writes successful build artifacts back to the incremental
// cache.  The existing incremental_cache.rs handles reads;
// this module handles the write side so that compile_gui.rs
// can persist successful builds.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// An entry written to the incremental cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    /// Content hash of the source files that produced this artifact.
    pub source_hash: String,
    /// Path to the cached artifact.
    pub artifact_path: PathBuf,
    /// ABI version of the artifact.
    pub abi_version: String,
    /// Language of the artifact.
    pub language: String,
    /// Timestamp of when this was cached (epoch ms).
    pub cached_at_ms: u64,
    /// Size in bytes.
    pub artifact_size: u64,
}

/// Write policy for the cache.
#[derive(Debug, Clone)]
pub struct CacheWritePolicy {
    /// Max entries in cache.
    pub max_entries: usize,
    /// Max total cache size in bytes.
    pub max_total_bytes: u64,
    /// Evict entries older than this (ms).
    pub max_age_ms: u64,
}

impl Default for CacheWritePolicy {
    fn default() -> Self {
        Self {
            max_entries: 128,
            max_total_bytes: 512 * 1024 * 1024, // 512 MB
            max_age_ms: 24 * 60 * 60 * 1000,    // 24 hours
        }
    }
}

/// In-memory incremental cache writer.
///
/// In production, this would write to disk; here we define the
/// logical operations.
#[derive(Debug, Default)]
pub struct IncrementalCacheWriter {
    entries: HashMap<String, CacheEntry>,
    policy: CacheWritePolicy,
}

impl IncrementalCacheWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_policy(policy: CacheWritePolicy) -> Self {
        Self {
            entries: HashMap::new(),
            policy,
        }
    }

    /// Write a build artifact to the cache.  
    /// Returns `true` if written, `false` if evicted to make room but couldn't fit.
    pub fn write(&mut self, key: &str, entry: CacheEntry) -> bool {
        // Evict stale entries first
        self.evict_stale(entry.cached_at_ms);

        // Evict oldest if at capacity
        while self.entries.len() >= self.policy.max_entries {
            if !self.evict_oldest() {
                return false;
            }
        }

        // Check total size
        let current_total: u64 = self.entries.values().map(|e| e.artifact_size).sum();
        if current_total + entry.artifact_size > self.policy.max_total_bytes {
            // Try to evict until we have room
            let needed = (current_total + entry.artifact_size) - self.policy.max_total_bytes;
            if !self.evict_bytes(needed) {
                return false;
            }
        }

        self.entries.insert(key.to_string(), entry);
        true
    }

    /// Look up a cache entry by key.
    pub fn get(&self, key: &str) -> Option<&CacheEntry> {
        self.entries.get(key)
    }

    /// Check if a key exists.
    pub fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// Remove a specific entry.
    pub fn invalidate(&mut self, key: &str) -> bool {
        self.entries.remove(key).is_some()
    }

    /// Invalidate all entries for a language.
    pub fn invalidate_language(&mut self, language: &str) -> usize {
        let keys: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.language == language)
            .map(|(k, _)| k.clone())
            .collect();
        let count = keys.len();
        for k in keys {
            self.entries.remove(&k);
        }
        count
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Total cached bytes.
    pub fn total_bytes(&self) -> u64 {
        self.entries.values().map(|e| e.artifact_size).sum()
    }

    /// Clear all cache entries.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn evict_stale(&mut self, current_time_ms: u64) {
        let cutoff = current_time_ms.saturating_sub(self.policy.max_age_ms);
        self.entries.retain(|_, e| e.cached_at_ms > cutoff);
    }

    fn evict_oldest(&mut self) -> bool {
        if let Some(oldest_key) = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.cached_at_ms)
            .map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest_key);
            true
        } else {
            false
        }
    }

    fn evict_bytes(&mut self, mut needed: u64) -> bool {
        let mut by_age: Vec<(String, u64, u64)> = self
            .entries
            .iter()
            .map(|(k, e)| (k.clone(), e.cached_at_ms, e.artifact_size))
            .collect();
        by_age.sort_by_key(|(_, age, _)| *age);

        for (key, _, size) in by_age {
            if needed == 0 {
                break;
            }
            self.entries.remove(&key);
            needed = needed.saturating_sub(size);
        }
        needed == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(hash: &str, size: u64, time: u64) -> CacheEntry {
        CacheEntry {
            source_hash: hash.into(),
            artifact_path: PathBuf::from("/tmp/cache"),
            abi_version: "1.0".into(),
            language: "rust".into(),
            cached_at_ms: time,
            artifact_size: size,
        }
    }

    #[test]
    fn write_and_get() {
        let mut cache = IncrementalCacheWriter::new();
        assert!(cache.write("k1", entry("h1", 1000, 100)));
        assert!(cache.contains("k1"));
        assert_eq!(cache.get("k1").unwrap().source_hash, "h1");
    }

    #[test]
    fn evict_on_capacity() {
        let policy = CacheWritePolicy {
            max_entries: 2,
            ..Default::default()
        };
        let mut cache = IncrementalCacheWriter::with_policy(policy);
        cache.write("k1", entry("h1", 100, 1));
        cache.write("k2", entry("h2", 100, 2));
        cache.write("k3", entry("h3", 100, 3));

        assert_eq!(cache.len(), 2);
        assert!(!cache.contains("k1")); // oldest evicted
        assert!(cache.contains("k3"));
    }

    #[test]
    fn invalidate_language() {
        let mut cache = IncrementalCacheWriter::new();
        cache.write("k1", entry("h1", 100, 1));
        let mut e2 = entry("h2", 100, 2);
        e2.language = "cpp".into();
        cache.write("k2", e2);

        let removed = cache.invalidate_language("rust");
        assert_eq!(removed, 1);
        assert_eq!(cache.len(), 1);
    }
}
