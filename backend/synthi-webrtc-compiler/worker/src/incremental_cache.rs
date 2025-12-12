// ============================================================
// INCREMENTAL COMPILATION CACHE
// ============================================================
// Caches object files (.o) by content hash to avoid redundant
// recompilation. Similar to how ccache works, but integrated
// into the HMR pipeline for faster iteration cycles.
//
// KEY FEATURES:
// - Content-addressable storage (hash → .o file)
// - Separate tracking for compile vs link steps
// - Automatic cleanup of stale entries
// - Thread-safe async access
// ============================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;
use tokio::sync::RwLock;
use tokio::fs;
use serde::{Serialize, Deserialize};

/// Maximum cache size in bytes (100 MB default)
const MAX_CACHE_SIZE_BYTES: u64 = 100 * 1024 * 1024;

/// Maximum age for cache entries (1 hour)
const MAX_CACHE_AGE_SECS: u64 = 3600;

/// Cache entry metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    /// Content hash of the source file
    pub source_hash: u64,
    /// Hash of compiler flags used
    pub flags_hash: u64,
    /// Hash of included headers (transitive)
    pub headers_hash: u64,
    /// Path to the cached object file
    pub object_path: PathBuf,
    /// Size in bytes
    pub size_bytes: u64,
    /// Unix timestamp of creation
    pub created_at: u64,
    /// Last access timestamp
    pub last_accessed: u64,
}

/// Compilation unit identifier
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CompileUnit {
    pub source_path: String,
    pub module_name: String, // "core", "gui", "main"
}

/// Incremental compilation cache
#[derive(Debug)]
pub struct IncrementalCache {
    /// Cache directory (typically /dev/shm or temp dir)
    cache_dir: PathBuf,
    /// In-memory index: CompileUnit -> CacheEntry
    index: RwLock<HashMap<String, CacheEntry>>,
    /// Total cache size
    total_size: RwLock<u64>,
}

impl IncrementalCache {
    /// Create a new cache in the specified directory
    pub async fn new(cache_dir: PathBuf) -> Result<Self, std::io::Error> {
        // Create cache directory if it doesn't exist
        fs::create_dir_all(&cache_dir).await?;
        
        // Load existing index if available
        let index_path = cache_dir.join("cache_index.json");
        let index = if index_path.exists() {
            match fs::read_to_string(&index_path).await {
                Ok(data) => {
                    serde_json::from_str(&data).unwrap_or_default()
                }
                Err(_) => HashMap::new()
            }
        } else {
            HashMap::new()
        };
        
        // Calculate total size
        let total_size: u64 = index.values().map(|e: &CacheEntry| e.size_bytes).sum();
        
        Ok(Self {
            cache_dir,
            index: RwLock::new(index),
            total_size: RwLock::new(total_size),
        })
    }
    
    /// Generate cache key from source content and compiler flags
    pub fn cache_key(source: &str, flags: &[&str], headers: &[(&str, &str)]) -> String {
        let mut hasher = DefaultHasher::new();
        source.hash(&mut hasher);
        let source_hash = hasher.finish();
        
        let mut hasher = DefaultHasher::new();
        for flag in flags {
            flag.hash(&mut hasher);
        }
        let flags_hash = hasher.finish();
        
        let mut hasher = DefaultHasher::new();
        for (name, content) in headers {
            name.hash(&mut hasher);
            content.hash(&mut hasher);
        }
        let headers_hash = hasher.finish();
        
        format!("{:016x}_{:016x}_{:016x}", source_hash, flags_hash, headers_hash)
    }
    
    /// Check if a compiled object exists in cache
    pub async fn get(&self, key: &str) -> Option<PathBuf> {
        let mut index = self.index.write().await;
        
        if let Some(entry) = index.get_mut(key) {
            // Check if object file still exists
            if entry.object_path.exists() {
                // Check age
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                
                if now - entry.created_at < MAX_CACHE_AGE_SECS {
                    // Update last accessed
                    entry.last_accessed = now;
                    return Some(entry.object_path.clone());
                }
            }
            
            // Entry is stale or missing, remove it
            let size = entry.size_bytes;
            index.remove(key);
            *self.total_size.write().await -= size;
        }
        
        None
    }
    
    /// Store a compiled object in cache
    pub async fn put(
        &self,
        key: String,
        source_hash: u64,
        flags_hash: u64,
        headers_hash: u64,
        object_data: &[u8],
    ) -> Result<PathBuf, std::io::Error> {
        // Check if we need to evict entries
        let size = object_data.len() as u64;
        self.maybe_evict(size).await;
        
        // Write object file
        let object_path = self.cache_dir.join(format!("{}.o", key));
        fs::write(&object_path, object_data).await?;
        
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        let entry = CacheEntry {
            source_hash,
            flags_hash,
            headers_hash,
            object_path: object_path.clone(),
            size_bytes: size,
            created_at: now,
            last_accessed: now,
        };
        
        // Update index
        {
            let mut index = self.index.write().await;
            if let Some(old) = index.insert(key.clone(), entry) {
                *self.total_size.write().await -= old.size_bytes;
            }
            *self.total_size.write().await += size;
        }
        
        // Persist index
        self.save_index().await?;
        
        Ok(object_path)
    }
    
    /// Evict entries if cache is too large
    async fn maybe_evict(&self, needed_bytes: u64) {
        let current_size = *self.total_size.read().await;
        
        if current_size + needed_bytes <= MAX_CACHE_SIZE_BYTES {
            return;
        }
        
        let mut index = self.index.write().await;
        
        // Sort entries by last_accessed (LRU eviction)
        let mut entries: Vec<_> = index.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        entries.sort_by_key(|(_, e)| e.last_accessed);
        
        let mut freed = 0u64;
        let target = current_size + needed_bytes - MAX_CACHE_SIZE_BYTES;
        
        for (key, entry) in entries {
            if freed >= target {
                break;
            }
            
            // Remove object file
            let _ = std::fs::remove_file(&entry.object_path);
            
            freed += entry.size_bytes;
            index.remove(&key);
        }
        
        *self.total_size.write().await = current_size - freed;
    }
    
    /// Save index to disk
    async fn save_index(&self) -> Result<(), std::io::Error> {
        let index = self.index.read().await;
        let data = serde_json::to_string_pretty(&*index).unwrap_or_default();
        let index_path = self.cache_dir.join("cache_index.json");
        fs::write(index_path, data).await
    }
    
    /// Clear the entire cache
    pub async fn clear(&self) -> Result<(), std::io::Error> {
        let mut index = self.index.write().await;
        
        for entry in index.values() {
            let _ = fs::remove_file(&entry.object_path).await;
        }
        
        index.clear();
        *self.total_size.write().await = 0;
        
        self.save_index().await
    }
    
    /// Get cache statistics
    pub async fn stats(&self) -> CacheStats {
        let index = self.index.read().await;
        let total_size = *self.total_size.read().await;
        
        CacheStats {
            entry_count: index.len(),
            total_size_bytes: total_size,
            cache_dir: self.cache_dir.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CacheStats {
    pub entry_count: usize,
    pub total_size_bytes: u64,
    pub cache_dir: PathBuf,
}

// ============================================================
// COMPILE STEP CACHING
// ============================================================
// Separate compile (.cpp → .o) from link (.o → .so) steps
// to maximize cache hits on incremental rebuilds.
// ============================================================

/// Result of a cached or fresh compilation
#[derive(Debug)]
pub enum CompileResult {
    /// Cache hit - object file already exists
    CacheHit {
        object_path: PathBuf,
        elapsed_ms: u64,
    },
    /// Cache miss - had to compile
    CacheMiss {
        object_path: PathBuf,
        elapsed_ms: u64,
    },
}

impl CompileResult {
    pub fn object_path(&self) -> &PathBuf {
        match self {
            CompileResult::CacheHit { object_path, .. } => object_path,
            CompileResult::CacheMiss { object_path, .. } => object_path,
        }
    }
    
    pub fn was_cached(&self) -> bool {
        matches!(self, CompileResult::CacheHit { .. })
    }
    
    pub fn elapsed_ms(&self) -> u64 {
        match self {
            CompileResult::CacheHit { elapsed_ms, .. } => *elapsed_ms,
            CompileResult::CacheMiss { elapsed_ms, .. } => *elapsed_ms,
        }
    }
}

/// Compile with caching support
pub async fn compile_with_cache(
    cache: &IncrementalCache,
    source_path: &Path,
    source_content: &str,
    headers: &[(&str, &str)],
    output_dir: &Path,
    compiler: &str,
    flags: &[&str],
) -> Result<CompileResult, String> {
    use std::time::Instant;
    use tokio::process::Command;
    
    let start = Instant::now();
    
    // Generate cache key
    let key = IncrementalCache::cache_key(source_content, flags, headers);
    
    // Check cache
    if let Some(cached_path) = cache.get(&key).await {
        let elapsed = start.elapsed().as_millis() as u64;
        eprintln!("[Cache] HIT for {} ({}ms)", source_path.display(), elapsed);
        return Ok(CompileResult::CacheHit {
            object_path: cached_path,
            elapsed_ms: elapsed,
        });
    }
    
    // Cache miss - compile
    eprintln!("[Cache] MISS for {} - compiling...", source_path.display());
    
    let object_path = output_dir.join(format!("{}.o", key));
    
    // Build compile command (compile only, no link)
    let mut cmd = Command::new(compiler);
    cmd.arg("-c") // Compile only
       .arg("-fPIC")
       .args(flags)
       .arg(source_path)
       .arg("-o")
       .arg(&object_path);
    
    if let Some(parent) = source_path.parent() {
        cmd.current_dir(parent);
    }
    
    let output = cmd.output().await.map_err(|e| format!("Failed to run compiler: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Compilation failed:\n{}", stderr));
    }
    
    // Read compiled object
    let object_data = tokio::fs::read(&object_path).await
        .map_err(|e| format!("Failed to read object file: {}", e))?;
    
    // Store in cache
    let mut hasher = DefaultHasher::new();
    source_content.hash(&mut hasher);
    let source_hash = hasher.finish();
    
    let mut hasher = DefaultHasher::new();
    for flag in flags {
        flag.hash(&mut hasher);
    }
    let flags_hash = hasher.finish();
    
    let mut hasher = DefaultHasher::new();
    for (name, content) in headers {
        name.hash(&mut hasher);
        content.hash(&mut hasher);
    }
    let headers_hash = hasher.finish();
    
    let cached_path = cache.put(key, source_hash, flags_hash, headers_hash, &object_data)
        .await
        .map_err(|e| format!("Failed to cache object: {}", e))?;
    
    let elapsed = start.elapsed().as_millis() as u64;
    eprintln!("[Cache] Compiled {} in {}ms", source_path.display(), elapsed);
    
    Ok(CompileResult::CacheMiss {
        object_path: cached_path,
        elapsed_ms: elapsed,
    })
}

/// Link object files into shared library
pub async fn link_objects(
    object_paths: &[PathBuf],
    output_path: &Path,
    linker: &str,
    flags: &[&str],
) -> Result<(), String> {
    use tokio::process::Command;
    use std::time::Instant;
    
    let start = Instant::now();
    
    let mut cmd = Command::new(linker);
    cmd.arg("-shared")
       .args(flags);
    
    for obj in object_paths {
        cmd.arg(obj);
    }
    
    cmd.arg("-o").arg(output_path);
    
    let output = cmd.output().await.map_err(|e| format!("Failed to run linker: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Linking failed:\n{}", stderr));
    }
    
    let elapsed = start.elapsed().as_millis() as u64;
    eprintln!("[Link] Linked {} objects to {} in {}ms", 
             object_paths.len(), output_path.display(), elapsed);
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    
    #[tokio::test]
    async fn test_cache_key_generation() {
        let key1 = IncrementalCache::cache_key("int main() {}", &["-O2"], &[]);
        let key2 = IncrementalCache::cache_key("int main() {}", &["-O2"], &[]);
        let key3 = IncrementalCache::cache_key("int main() {}", &["-O3"], &[]);
        
        assert_eq!(key1, key2);
        assert_ne!(key1, key3);
    }
    
    #[tokio::test]
    async fn test_cache_put_get() {
        let dir = tempdir().unwrap();
        let cache = IncrementalCache::new(dir.path().to_path_buf()).await.unwrap();
        
        let key = "test_key".to_string();
        let data = b"fake object data";
        
        let path = cache.put(key.clone(), 123, 456, 789, data).await.unwrap();
        assert!(path.exists());
        
        let retrieved = cache.get(&key).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap(), path);
    }
}
