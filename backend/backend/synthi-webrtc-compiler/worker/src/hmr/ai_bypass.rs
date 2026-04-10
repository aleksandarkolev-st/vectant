// ============================================================
// AI BYPASS FOR HOT PATH
// ============================================================
// Wraps around perform_ai_split to enforce the AI gate.
// When the gate blocks (Loop A), returns a cached/existing
// split result instead of calling the AI endpoint.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::hmr::ai_gate::{AiGate, AiGateDecision};
use crate::hmr::loop_classifier::CompileLoop;

/// Cached AI split result keyed by source hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSplitResult {
    /// Hash of the original source that produced this split.
    pub source_hash: String,

    /// Core module source code.
    pub core_code: String,

    /// GUI module source code.
    pub gui_code: String,

    /// Shared header source code (if any).
    pub shared_code: Option<String>,

    /// Language.
    pub language: String,

    /// Timestamp of when this result was cached (unix seconds).
    pub cached_at: u64,
}

/// Thread-safe split result cache.
#[derive(Debug, Clone)]
pub struct SplitCache {
    entries: Arc<RwLock<HashMap<String, CachedSplitResult>>>,
    max_entries: usize,
}

impl SplitCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            max_entries,
        }
    }

    /// Look up a cached split result by source hash.
    pub fn get(&self, source_hash: &str) -> Option<CachedSplitResult> {
        let guard = self.entries.read().ok()?;
        guard.get(source_hash).cloned()
    }

    /// Store a split result.
    pub fn put(&self, result: CachedSplitResult) {
        if let Ok(mut guard) = self.entries.write() {
            // Simple eviction: if full, clear oldest half
            if guard.len() >= self.max_entries {
                let mut entries: Vec<_> = guard.drain().collect();
                entries.sort_by_key(|(_, r)| r.cached_at);
                let keep = entries.len() / 2;
                *guard = entries.into_iter().skip(keep).collect();
            }
            guard.insert(result.source_hash.clone(), result);
        }
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.read().map(|g| g.len()).unwrap_or(0)
    }

    /// Clear the cache.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.entries.write() {
            guard.clear();
        }
    }
}

/// Outcome of the AI bypass check.
#[derive(Debug, Clone)]
pub enum AiBypassResult {
    /// AI call is allowed; proceed with the endpoint.
    Proceed,

    /// AI call was blocked; use this cached result instead.
    UseCached(CachedSplitResult),

    /// AI call was blocked and no cached result exists.
    /// The caller should fall back to the deterministic path.
    FallbackDeterministic,
}

/// Check whether an AI split call should proceed or be bypassed.
///
/// This is the main entry point called before perform_ai_split().
pub fn check_ai_bypass(
    gate: &AiGate,
    cache: &SplitCache,
    loop_type: CompileLoop,
    source_hash: &str,
) -> AiBypassResult {
    let decision = gate.check(loop_type, "/refactor/split");

    match decision {
        AiGateDecision::Allowed { .. } => AiBypassResult::Proceed,
        AiGateDecision::Blocked { .. } => {
            // Try to use cached result
            match cache.get(source_hash) {
                Some(cached) => AiBypassResult::UseCached(cached),
                None => AiBypassResult::FallbackDeterministic,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cache_entry(hash: &str) -> CachedSplitResult {
        CachedSplitResult {
            source_hash: hash.into(),
            core_code: "// core".into(),
            gui_code: "// gui".into(),
            shared_code: None,
            language: "cpp".into(),
            cached_at: 1000,
        }
    }

    #[test]
    fn loop_b_proceeds() {
        let gate = AiGate::new();
        let cache = SplitCache::new(10);
        let result = check_ai_bypass(&gate, &cache, CompileLoop::LoopB, "h1");
        assert!(matches!(result, AiBypassResult::Proceed));
    }

    #[test]
    fn loop_a_uses_cache_if_available() {
        let gate = AiGate::new();
        let cache = SplitCache::new(10);
        cache.put(make_cache_entry("h1"));

        let result = check_ai_bypass(&gate, &cache, CompileLoop::LoopA, "h1");
        assert!(matches!(result, AiBypassResult::UseCached(_)));
    }

    #[test]
    fn loop_a_falls_back_if_no_cache() {
        let gate = AiGate::new();
        let cache = SplitCache::new(10);

        let result = check_ai_bypass(&gate, &cache, CompileLoop::LoopA, "h1");
        assert!(matches!(result, AiBypassResult::FallbackDeterministic));
    }

    #[test]
    fn cache_eviction() {
        let cache = SplitCache::new(3);
        cache.put(make_cache_entry("h1"));
        cache.put(make_cache_entry("h2"));
        cache.put(make_cache_entry("h3"));
        assert_eq!(cache.len(), 3);

        // This should trigger eviction
        cache.put(make_cache_entry("h4"));
        assert!(cache.len() <= 3);
    }
}
