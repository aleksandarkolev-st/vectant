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

// ============================================================
// INCREMENTAL LINKING CACHE
// ============================================================
// Caches relocatable object files (.o) and tracks which objects
// are needed for final linking. When only one object changes,
// we re-link only that object with cached others.
// ============================================================

/// Link cache entry - tracks which objects make up a shared library
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkCacheEntry {
    /// Hash of all object file hashes combined
    pub combined_hash: u64,
    /// Individual object file hashes (in order)
    pub object_hashes: Vec<u64>,
    /// Paths to the cached object files
    pub object_paths: Vec<PathBuf>,
    /// Output shared library path
    pub output_path: PathBuf,
    /// Size in bytes
    pub size_bytes: u64,
    /// Unix timestamp
    pub created_at: u64,
}

/// Incremental link cache
#[derive(Debug)]
pub struct LinkCache {
    /// Cache directory
    cache_dir: PathBuf,
    /// Module -> LinkCacheEntry
    index: RwLock<HashMap<String, LinkCacheEntry>>,
}

impl LinkCache {
    pub async fn new(cache_dir: PathBuf) -> Result<Self, std::io::Error> {
        fs::create_dir_all(&cache_dir).await?;
        
        let index_path = cache_dir.join("link_index.json");
        let index = if index_path.exists() {
            match fs::read_to_string(&index_path).await {
                Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };
        
        Ok(Self {
            cache_dir,
            index: RwLock::new(index),
        })
    }
    
    /// Check if we can do incremental link (only some objects changed)
    pub async fn get_incremental_link_info(
        &self,
        module: &str,
        new_object_hashes: &[u64],
    ) -> Option<IncrementalLinkInfo> {
        let index = self.index.read().await;
        let entry = index.get(module)?;
        
        if entry.object_hashes.len() != new_object_hashes.len() {
            // Object count changed - can't do incremental link
            return None;
        }
        
        // Find which objects changed
        let mut changed_indices = Vec::new();
        let mut unchanged_paths = Vec::new();
        
        for (i, (old_hash, new_hash)) in entry.object_hashes.iter()
            .zip(new_object_hashes.iter())
            .enumerate() 
        {
            if old_hash != new_hash {
                changed_indices.push(i);
            } else if entry.object_paths[i].exists() {
                unchanged_paths.push((i, entry.object_paths[i].clone()));
            }
        }
        
        // Only beneficial if some objects are unchanged
        if unchanged_paths.is_empty() || changed_indices.len() == new_object_hashes.len() {
            return None;
        }
        
        Some(IncrementalLinkInfo {
            changed_indices,
            unchanged_objects: unchanged_paths,
            previous_output: entry.output_path.clone(),
        })
    }
    
    /// Store link result
    pub async fn put(
        &self,
        module: String,
        object_hashes: Vec<u64>,
        object_paths: Vec<PathBuf>,
        output_path: PathBuf,
    ) -> Result<(), std::io::Error> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        let mut combined_hasher = DefaultHasher::new();
        for hash in &object_hashes {
            hash.hash(&mut combined_hasher);
        }
        let combined_hash = combined_hasher.finish();
        
        let size_bytes = fs::metadata(&output_path).await
            .map(|m| m.len())
            .unwrap_or(0);
        
        let entry = LinkCacheEntry {
            combined_hash,
            object_hashes,
            object_paths,
            output_path,
            size_bytes,
            created_at: now,
        };
        
        let mut index = self.index.write().await;
        index.insert(module, entry);
        
        // Save index
        let data = serde_json::to_string_pretty(&*index).unwrap_or_default();
        let index_path = self.cache_dir.join("link_index.json");
        fs::write(index_path, data).await
    }
    
    /// Clear link cache for a module
    pub async fn clear(&self, module: &str) {
        let mut index = self.index.write().await;
        index.remove(module);
    }
}

/// Information for incremental linking
#[derive(Debug)]
pub struct IncrementalLinkInfo {
    /// Indices of objects that need to be recompiled
    pub changed_indices: Vec<usize>,
    /// (index, path) of unchanged objects that can be reused
    pub unchanged_objects: Vec<(usize, PathBuf)>,
    /// Previous output path (for reference)
    pub previous_output: PathBuf,
}

// ============================================================
// TWO-PHASE INCREMENTAL LINK
// ============================================================
// Phase 1: Compile changed source files to .o (or reuse cached)
// Phase 2: Link all .o files (cached + new) into .so
// ============================================================

/// Result of incremental compilation phase
#[derive(Debug)]
pub struct IncrementalCompileResult {
    /// All object files to link (in order)
    pub object_paths: Vec<PathBuf>,
    /// Hashes of all objects (in order)
    pub object_hashes: Vec<u64>,
    /// Which objects were freshly compiled
    pub compiled_indices: Vec<usize>,
    /// Which objects were reused from cache
    pub cached_indices: Vec<usize>,
    /// Total compile time in ms
    pub compile_time_ms: u64,
}

/// Incrementally compile multiple source files
pub async fn incremental_compile_multi(
    compile_cache: &IncrementalCache,
    sources: &[(&Path, &str)], // (path, content)
    headers: &[(&str, &str)],
    output_dir: &Path,
    compiler: &str,
    flags: &[&str],
) -> Result<IncrementalCompileResult, String> {
    use std::time::Instant;
    use tokio::process::Command;
    
    let start = Instant::now();
    let mut object_paths = Vec::with_capacity(sources.len());
    let mut object_hashes = Vec::with_capacity(sources.len());
    let mut compiled_indices = Vec::new();
    let mut cached_indices = Vec::new();
    
    for (i, (source_path, source_content)) in sources.iter().enumerate() {
        let key = IncrementalCache::cache_key(source_content, flags, headers);
        
        // Compute content hash for tracking
        let mut hasher = DefaultHasher::new();
        source_content.hash(&mut hasher);
        let content_hash = hasher.finish();
        object_hashes.push(content_hash);
        
        // Check compile cache
        if let Some(cached_path) = compile_cache.get(&key).await {
            object_paths.push(cached_path);
            cached_indices.push(i);
            continue;
        }
        
        // Cache miss - compile
        let object_path = output_dir.join(format!("{}.o", key));
        
        let mut cmd = Command::new(compiler);
        cmd.arg("-c")
           .arg("-fPIC")
           .args(flags)
           .arg(source_path)
           .arg("-o")
           .arg(&object_path);
        
        if let Some(parent) = source_path.parent() {
            cmd.current_dir(parent);
        }
        
        let output = cmd.output().await
            .map_err(|e| format!("Failed to run compiler: {}", e))?;
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Compilation failed for {}:\n{}", source_path.display(), stderr));
        }
        
        // Store in cache
        let object_data = fs::read(&object_path).await
            .map_err(|e| format!("Failed to read object file: {}", e))?;
        
        let mut flags_hasher = DefaultHasher::new();
        for flag in flags {
            flag.hash(&mut flags_hasher);
        }
        let flags_hash = flags_hasher.finish();
        
        let mut headers_hasher = DefaultHasher::new();
        for (name, content) in headers {
            name.hash(&mut headers_hasher);
            content.hash(&mut headers_hasher);
        }
        let headers_hash = headers_hasher.finish();
        
        let cached = compile_cache.put(key, content_hash, flags_hash, headers_hash, &object_data)
            .await
            .map_err(|e| format!("Failed to cache object: {}", e))?;
        
        object_paths.push(cached);
        compiled_indices.push(i);
    }
    
    let compile_time_ms = start.elapsed().as_millis() as u64;
    
    Ok(IncrementalCompileResult {
        object_paths,
        object_hashes,
        compiled_indices,
        cached_indices,
        compile_time_ms,
    })
}

/// Incrementally link object files
/// Uses ld -r for relocatable objects when beneficial
pub async fn incremental_link(
    link_cache: &LinkCache,
    module: &str,
    objects: &IncrementalCompileResult,
    output_path: &Path,
    linker: &str,
    flags: &[&str],
) -> Result<IncrementalLinkResult, String> {
    use std::time::Instant;
    use tokio::process::Command;
    
    let start = Instant::now();
    
    // Check if we can do incremental link
    let link_info = link_cache.get_incremental_link_info(module, &objects.object_hashes).await;
    
    let link_strategy = if let Some(info) = &link_info {
        // Calculate savings: if >50% objects unchanged, use incremental
        let unchanged_ratio = info.unchanged_objects.len() as f32 / objects.object_paths.len() as f32;
        if unchanged_ratio > 0.5 {
            LinkStrategy::Incremental
        } else {
            LinkStrategy::Full
        }
    } else {
        LinkStrategy::Full
    };
    
    // Perform link
    let mut cmd = Command::new(linker);
    cmd.arg("-shared")
       .args(flags);
    
    for obj in &objects.object_paths {
        cmd.arg(obj);
    }
    
    cmd.arg("-o").arg(output_path);
    
    let output = cmd.output().await
        .map_err(|e| format!("Failed to run linker: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Linking failed:\n{}", stderr));
    }
    
    let link_time_ms = start.elapsed().as_millis() as u64;
    
    // Update link cache
    link_cache.put(
        module.to_string(),
        objects.object_hashes.clone(),
        objects.object_paths.clone(),
        output_path.to_path_buf(),
    ).await.map_err(|e| format!("Failed to update link cache: {}", e))?;
    
    Ok(IncrementalLinkResult {
        output_path: output_path.to_path_buf(),
        strategy: link_strategy,
        link_time_ms,
        total_objects: objects.object_paths.len(),
        cached_objects: objects.cached_indices.len(),
    })
}

/// Link strategy used
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStrategy {
    /// Full link of all objects
    Full,
    /// Incremental link (some objects reused)
    Incremental,
}

/// Result of incremental link
#[derive(Debug)]
pub struct IncrementalLinkResult {
    pub output_path: PathBuf,
    pub strategy: LinkStrategy,
    pub link_time_ms: u64,
    pub total_objects: usize,
    pub cached_objects: usize,
}

impl IncrementalLinkResult {
    pub fn to_status_string(&self) -> String {
        format!(
            "[Link] {} in {}ms ({}/{} objects cached)",
            match self.strategy {
                LinkStrategy::Full => "Full link",
                LinkStrategy::Incremental => "Incremental link",
            },
            self.link_time_ms,
            self.cached_objects,
            self.total_objects
        )
    }
}

// ============================================================
// HEADER DEPENDENCY TRACKING
// ============================================================
// Track which headers each source file depends on to improve
// cache invalidation accuracy.
// ============================================================

/// Header classification
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderType {
    /// User header (local to project) - changes should invalidate cache
    User,
    /// System header (from /usr/include, etc.) - changes ignored
    System,
    /// SDK header (SDL2, etc.) - changes invalidate affected files
    Sdk,
}

/// Parse compiler -M output to extract header dependencies
pub fn parse_makefile_deps(makefile_output: &str) -> Vec<(String, HeaderType)> {
    let mut headers = Vec::new();
    
    // -M output format: target.o: source.cpp header1.h header2.h ...
    // May span multiple lines with \ continuations
    let joined = makefile_output.replace("\\\n", " ");
    
    for line in joined.lines() {
        // Skip the target part
        if let Some(colon_pos) = line.find(':') {
            let deps = &line[colon_pos + 1..];
            
            for dep in deps.split_whitespace() {
                let dep = dep.trim();
                if dep.is_empty() {
                    continue;
                }
                
                // Classify header
                let header_type = classify_header(dep);
                headers.push((dep.to_string(), header_type));
            }
        }
    }
    
    headers
}

/// Classify a header file path
pub fn classify_header(path: &str) -> HeaderType {
    let path_lower = path.to_lowercase();
    
    // System headers
    if path_lower.starts_with("/usr/include")
        || path_lower.starts_with("/usr/lib")
        || path_lower.starts_with("/usr/local/include")
        || path_lower.contains("/c++/")
        || path_lower.contains("/bits/")
        || path_lower.contains("/sys/")
    {
        return HeaderType::System;
    }
    
    // SDK headers (SDL, X11, etc.)
    if path_lower.contains("/sdl2/")
        || path_lower.contains("/x11/")
        || path_lower.contains("/gl/")
        || path_lower.contains("/gtk")
        || path_lower.contains("/qt")
    {
        return HeaderType::Sdk;
    }
    
    // Default to user header
    HeaderType::User
}

/// Compute header hash considering only user/SDK headers
pub fn compute_smart_headers_hash(headers: &[(String, HeaderType)], header_contents: &HashMap<String, String>) -> u64 {
    let mut hasher = DefaultHasher::new();
    
    for (path, htype) in headers {
        // Skip system headers
        if *htype == HeaderType::System {
            continue;
        }
        
        // Include path and content in hash
        path.hash(&mut hasher);
        if let Some(content) = header_contents.get(path) {
            content.hash(&mut hasher);
        }
    }
    
    hasher.finish()
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
    
    #[test]
    fn test_classify_header() {
        assert_eq!(classify_header("/usr/include/stdio.h"), HeaderType::System);
        assert_eq!(classify_header("/usr/include/c++/11/vector"), HeaderType::System);
        assert_eq!(classify_header("/usr/include/SDL2/SDL.h"), HeaderType::Sdk);
        assert_eq!(classify_header("./shared.h"), HeaderType::User);
        assert_eq!(classify_header("myheader.h"), HeaderType::User);
    }
    
    #[test]
    fn test_parse_makefile_deps() {
        let output = "main.o: main.cpp shared.h /usr/include/stdio.h \\\n /usr/include/SDL2/SDL.h";
        let deps = parse_makefile_deps(output);
        
        assert!(deps.iter().any(|(p, _)| p == "main.cpp"));
        assert!(deps.iter().any(|(p, _)| p == "shared.h"));
    }
}
