// ============================================================
// AI CACHE LAYER
// ============================================================
// Caches AI responses keyed by a semantic hash of the request.
// Avoids redundant AI calls for identical or near-identical
// request contexts.
// ============================================================

#![allow(dead_code)]

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::hmr::ai_request_contract::{AiRequest, AiResponse};

/// Cache configuration.
#[derive(Debug, Clone)]
pub struct AiCacheConfig {
    /// Maximum number of cached entries.
    pub max_entries: usize,
    /// Maximum age of a cache entry (millis).
    pub max_age_ms: u64,
    /// Whether to use fuzzy matching (ignore minor context differences).
    pub fuzzy_match: bool,
}

impl Default for AiCacheConfig {
    fn default() -> Self {
        Self {
            max_entries: 128,
            max_age_ms: 5 * 60 * 1000, // 5 minutes
            fuzzy_match: false,
        }
    }
}

/// A cached AI response with metadata.
#[derive(Debug, Clone)]
struct CacheEntry {
    response: AiResponse,
    cache_key: u64,
    cached_at_ms: u64,
    hit_count: u32,
}

/// LRU-evicted AI response cache.
pub struct AiCache {
    config: AiCacheConfig,
    entries: HashMap<u64, CacheEntry>,
    /// Insertion order for LRU eviction.
    order: Vec<u64>,
}

/// Compute a semantic cache key from the request.
/// Ignores volatile fields like request_id, timeout, attempt.
fn compute_cache_key(req: &AiRequest) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Hash the stable parts of the request
    std::mem::discriminant(&req.reason).hash(&mut hasher);
    req.context.module_id.hash(&mut hasher);
    for path in &req.context.file_paths {
        path.hash(&mut hasher);
    }
    for err in &req.context.errors {
        err.hash(&mut hasher);
    }
    for snippet in &req.context.source_snippets {
        snippet.file_path.hash(&mut hasher);
        snippet.content.hash(&mut hasher);
    }
    hasher.finish()
}

impl AiCache {
    pub fn new(config: AiCacheConfig) -> Self {
        Self {
            entries: HashMap::with_capacity(config.max_entries),
            order: Vec::with_capacity(config.max_entries),
            config,
        }
    }

    /// Look up a cached response for a request.
    pub fn get(&mut self, req: &AiRequest, now_ms: u64) -> Option<&AiResponse> {
        let key = compute_cache_key(req);

        // Check existence and age
        let expired = if let Some(entry) = self.entries.get(&key) {
            now_ms.saturating_sub(entry.cached_at_ms) > self.config.max_age_ms
        } else {
            return None;
        };

        if expired {
            self.entries.remove(&key);
            self.order.retain(|k| *k != key);
            return None;
        }

        // Update hit count and LRU position
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.hit_count += 1;
            // Move to end (most recently used)
            self.order.retain(|k| *k != key);
            self.order.push(key);
            Some(&entry.response)
        } else {
            None
        }
    }

    /// Store a response in the cache.
    pub fn put(&mut self, req: &AiRequest, response: AiResponse, now_ms: u64) {
        // Only cache successful responses
        if !response.success {
            return;
        }

        let key = compute_cache_key(req);

        // Evict if at capacity
        while self.entries.len() >= self.config.max_entries {
            if let Some(oldest_key) = self.order.first().cloned() {
                self.entries.remove(&oldest_key);
                self.order.remove(0);
            } else {
                break;
            }
        }

        self.entries.insert(
            key,
            CacheEntry {
                response,
                cache_key: key,
                cached_at_ms: now_ms,
                hit_count: 0,
            },
        );
        self.order.push(key);
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    /// Evict entries older than max_age.
    pub fn evict_stale(&mut self, now_ms: u64) {
        let max_age = self.config.max_age_ms;
        let stale_keys: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, e)| now_ms.saturating_sub(e.cached_at_ms) > max_age)
            .map(|(k, _)| *k)
            .collect();

        for key in &stale_keys {
            self.entries.remove(key);
        }
        self.order.retain(|k| !stale_keys.contains(k));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::ai_request_contract::*;

    fn test_request(module: &str) -> AiRequest {
        AiRequest {
            request_id: "req-1".into(),
            reason: AiRequestReason::SplitUnknown,
            priority: AiPriority::Medium,
            context: AiContext {
                module_id: module.into(),
                file_paths: vec!["src/main.rs".into()],
                source_snippets: vec![],
                errors: vec![],
                adapter_family: None,
                build_summary: None,
            },
            timeout_ms: 5000,
            fallback_available: true,
            attempt: 1,
            max_attempts: 3,
        }
    }

    fn test_response() -> AiResponse {
        AiResponse {
            request_id: "req-1".into(),
            success: true,
            recommendation: Some(AiRecommendation::NoRecommendation {
                reason: "test".into(),
            }),
            error: None,
            processing_ms: 100,
            model_id: None,
            tokens_used: None,
        }
    }

    #[test]
    fn cache_hit() {
        let mut cache = AiCache::new(AiCacheConfig::default());
        let req = test_request("mod_a");
        cache.put(&req, test_response(), 1000);
        assert!(cache.get(&req, 2000).is_some());
    }

    #[test]
    fn cache_miss_expired() {
        let mut cache = AiCache::new(AiCacheConfig {
            max_age_ms: 1000,
            ..Default::default()
        });
        let req = test_request("mod_a");
        cache.put(&req, test_response(), 1000);
        assert!(cache.get(&req, 3000).is_none());
    }

    #[test]
    fn lru_eviction() {
        let mut cache = AiCache::new(AiCacheConfig {
            max_entries: 2,
            ..Default::default()
        });
        cache.put(&test_request("a"), test_response(), 1000);
        cache.put(&test_request("b"), test_response(), 2000);
        cache.put(&test_request("c"), test_response(), 3000);
        assert_eq!(cache.len(), 2);
        // "a" should have been evicted
        assert!(cache.get(&test_request("a"), 3000).is_none());
    }
}
