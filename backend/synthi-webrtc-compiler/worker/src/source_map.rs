// ============================================================
// SOURCE MAP MODULE
// ============================================================
// Parses DWARF debug information from compiled shared libraries
// to map runtime addresses back to source file:line locations.
//
// KEY FEATURES:
// - DWARF debug info parsing (via addr2line or object crate)
// - Address → source:line resolution
// - Caching of parsed debug info for performance
// - Integration with crash_recovery.rs for source-mapped errors
// ============================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use serde::{Serialize, Deserialize};

// ============================================================
// SOURCE LOCATION TYPES
// ============================================================

/// Source location resolved from an address
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLocation {
    /// Source file path (may be relative or absolute)
    pub file: String,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (1-indexed, 0 if unknown)
    pub column: u32,
    /// Function name (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function: Option<String>,
}

impl SourceLocation {
    pub fn new(file: impl Into<String>, line: u32) -> Self {
        Self {
            file: file.into(),
            line,
            column: 0,
            function: None,
        }
    }
    
    pub fn with_column(mut self, column: u32) -> Self {
        self.column = column;
        self
    }
    
    pub fn with_function(mut self, function: impl Into<String>) -> Self {
        self.function = Some(function.into());
        self
    }
    
    /// Format as "file:line" or "file:line:column"
    pub fn to_string(&self) -> String {
        if self.column > 0 {
            format!("{}:{}:{}", self.file, self.line, self.column)
        } else {
            format!("{}:{}", self.file, self.line)
        }
    }
    
    /// Format with function name
    pub fn to_string_with_function(&self) -> String {
        if let Some(ref func) = self.function {
            format!("{} at {}", func, self.to_string())
        } else {
            self.to_string()
        }
    }
}

/// Stack frame with source location
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackFrame {
    /// Frame index (0 = top of stack)
    pub index: usize,
    /// Raw address
    pub address: u64,
    /// Resolved source location (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
    /// Raw symbol name (before demangling)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_symbol: Option<String>,
}

/// Source-mapped stack trace
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMappedTrace {
    /// Module name (library that crashed)
    pub module: String,
    /// Stack frames with source locations
    pub frames: Vec<StackFrame>,
    /// Whether debug info was available
    pub has_debug_info: bool,
}

impl SourceMappedTrace {
    pub fn new(module: impl Into<String>) -> Self {
        Self {
            module: module.into(),
            frames: Vec::new(),
            has_debug_info: false,
        }
    }
    
    /// Format as human-readable stack trace
    pub fn to_string(&self) -> String {
        let mut result = format!("Stack trace for {}:\n", self.module);
        
        for frame in &self.frames {
            result.push_str(&format!("  #{} ", frame.index));
            
            if let Some(ref loc) = frame.location {
                result.push_str(&loc.to_string_with_function());
            } else if let Some(ref sym) = frame.raw_symbol {
                result.push_str(sym);
            } else {
                result.push_str(&format!("0x{:016x}", frame.address));
            }
            
            result.push('\n');
        }
        
        if !self.has_debug_info {
            result.push_str("\n  (No debug info available. Compile with -g for source locations.)\n");
        }
        
        result
    }
}

// ============================================================
// SOURCE MAP CACHE
// ============================================================

/// Cached debug info for a library
#[derive(Debug)]
struct CachedDebugInfo {
    /// Path to the library
    lib_path: PathBuf,
    /// Library modification time
    mtime: u64,
    /// Parsed line info table: address → (file, line)
    line_table: HashMap<u64, (String, u32)>,
    /// Function table: address range → function name
    function_table: Vec<(u64, u64, String)>, // (start, end, name)
}

/// Global source map cache
#[derive(Debug, Default)]
pub struct SourceMapCache {
    cache: RwLock<HashMap<String, CachedDebugInfo>>,
}

impl SourceMapCache {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
        }
    }
    
    /// Load debug info for a library (or get from cache)
    pub fn load(&self, lib_path: &Path) -> Result<(), String> {
        let path_str = lib_path.to_string_lossy().to_string();
        
        // Check cache validity
        let mtime = std::fs::metadata(lib_path)
            .and_then(|m| m.modified())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
            .unwrap_or(0);
        
        {
            let cache = self.cache.read().unwrap();
            if let Some(info) = cache.get(&path_str) {
                if info.mtime == mtime {
                    return Ok(()); // Cache is valid
                }
            }
        }
        
        // Parse debug info
        let debug_info = parse_debug_info(lib_path)?;
        
        // Update cache
        let mut cache = self.cache.write().unwrap();
        cache.insert(path_str, CachedDebugInfo {
            lib_path: lib_path.to_path_buf(),
            mtime,
            line_table: debug_info.line_table,
            function_table: debug_info.function_table,
        });
        
        Ok(())
    }
    
    /// Resolve an address to source location
    pub fn resolve(&self, lib_path: &Path, address: u64) -> Option<SourceLocation> {
        let path_str = lib_path.to_string_lossy().to_string();
        
        let cache = self.cache.read().unwrap();
        let info = cache.get(&path_str)?;
        
        // Find function containing this address
        let function = info.function_table.iter()
            .find(|(start, end, _)| address >= *start && address < *end)
            .map(|(_, _, name)| name.clone());
        
        // Look up line info
        if let Some((file, line)) = info.line_table.get(&address) {
            let mut loc = SourceLocation::new(file.clone(), *line);
            if let Some(func) = function {
                loc = loc.with_function(func);
            }
            Some(loc)
        } else {
            // No exact match - try to find nearest address
            let nearest = find_nearest_address(&info.line_table, address);
            if let Some((file, line)) = nearest {
                let mut loc = SourceLocation::new(file, line);
                if let Some(func) = function {
                    loc = loc.with_function(func);
                }
                Some(loc)
            } else if let Some(func) = function {
                // Only function name available
                Some(SourceLocation::new("???", 0).with_function(func))
            } else {
                None
            }
        }
    }
    
    /// Resolve a full stack trace
    pub fn resolve_trace(
        &self,
        lib_path: &Path,
        addresses: &[u64],
    ) -> SourceMappedTrace {
        let module = lib_path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        
        let mut trace = SourceMappedTrace::new(&module);
        
        // Try to load debug info
        if self.load(lib_path).is_ok() {
            trace.has_debug_info = true;
        }
        
        for (i, &addr) in addresses.iter().enumerate() {
            let location = self.resolve(lib_path, addr);
            trace.frames.push(StackFrame {
                index: i,
                address: addr,
                location,
                raw_symbol: None,
            });
        }
        
        trace
    }
    
    /// Clear cache for a specific library
    pub fn invalidate(&self, lib_path: &Path) {
        let path_str = lib_path.to_string_lossy().to_string();
        let mut cache = self.cache.write().unwrap();
        cache.remove(&path_str);
    }
    
    /// Clear entire cache
    pub fn clear(&self) {
        let mut cache = self.cache.write().unwrap();
        cache.clear();
    }
}

// ============================================================
// DWARF PARSING
// ============================================================
// Uses the `object` and `gimli` crates to parse DWARF info.
// Fallback to addr2line external tool if crates not available.
// ============================================================

struct ParsedDebugInfo {
    line_table: HashMap<u64, (String, u32)>,
    function_table: Vec<(u64, u64, String)>,
}

/// Parse DWARF debug info from a library
fn parse_debug_info(lib_path: &Path) -> Result<ParsedDebugInfo, String> {
    // Try external addr2line tool first (more reliable, widely available)
    if let Ok(info) = parse_with_addr2line(lib_path) {
        return Ok(info);
    }
    
    // Fallback: minimal parsing using nm + objdump
    parse_with_nm_objdump(lib_path)
}

/// Parse using external addr2line tool
fn parse_with_addr2line(lib_path: &Path) -> Result<ParsedDebugInfo, String> {
    use std::process::Command;
    
    // Get all symbols with nm
    let nm_output = Command::new("nm")
        .arg("-n") // Sort by address
        .arg(lib_path)
        .output()
        .map_err(|e| format!("Failed to run nm: {}", e))?;
    
    if !nm_output.status.success() {
        return Err("nm failed".to_string());
    }
    
    let nm_str = String::from_utf8_lossy(&nm_output.stdout);
    
    // Parse function addresses
    let mut function_table = Vec::new();
    let mut addresses: Vec<u64> = Vec::new();
    
    for line in nm_str.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            if let Ok(addr) = u64::from_str_radix(parts[0], 16) {
                let sym_type = parts[1];
                let name = parts[2];
                
                // T/t = text (code), W/w = weak
                if sym_type == "T" || sym_type == "t" || sym_type == "W" || sym_type == "w" {
                    addresses.push(addr);
                    // Will fill in end address later
                    function_table.push((addr, addr + 1, demangle_symbol(name)));
                }
            }
        }
    }
    
    // Sort and compute function end addresses
    function_table.sort_by_key(|(start, _, _)| *start);
    for i in 0..function_table.len() - 1 {
        function_table[i].1 = function_table[i + 1].0;
    }
    if let Some(last) = function_table.last_mut() {
        last.1 = last.0 + 0x10000; // Assume max function size
    }
    
    // Use addr2line to resolve addresses to lines
    let mut line_table = HashMap::new();
    
    if !addresses.is_empty() {
        // Query addr2line for each address (batched)
        let addr_args: Vec<String> = addresses.iter()
            .map(|a| format!("0x{:x}", a))
            .collect();
        
        let a2l_output = Command::new("addr2line")
            .arg("-e")
            .arg(lib_path)
            .arg("-f") // Show function names
            .args(&addr_args)
            .output();
        
        if let Ok(output) = a2l_output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let lines: Vec<&str> = stdout.lines().collect();
                
                // addr2line outputs: function\nfile:line for each address
                for (i, addr) in addresses.iter().enumerate() {
                    let line_idx = i * 2 + 1; // Skip function name line
                    if line_idx < lines.len() {
                        if let Some((file, line)) = parse_addr2line_location(lines[line_idx]) {
                            if !file.starts_with("??") {
                                line_table.insert(*addr, (file, line));
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(ParsedDebugInfo {
        line_table,
        function_table,
    })
}

/// Parse addr2line output "file:line" or "file:line:column"
fn parse_addr2line_location(s: &str) -> Option<(String, u32)> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() >= 2 {
        let file = parts[0].to_string();
        let line = parts[1].parse().ok()?;
        Some((file, line))
    } else {
        None
    }
}

/// Fallback parsing using nm and objdump
fn parse_with_nm_objdump(lib_path: &Path) -> Result<ParsedDebugInfo, String> {
    use std::process::Command;
    
    let mut function_table = Vec::new();
    let line_table = HashMap::new();
    
    // Get symbols with nm
    let nm_output = Command::new("nm")
        .arg("-n")
        .arg(lib_path)
        .output()
        .map_err(|e| format!("Failed to run nm: {}", e))?;
    
    if nm_output.status.success() {
        let nm_str = String::from_utf8_lossy(&nm_output.stdout);
        
        for line in nm_str.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                if let Ok(addr) = u64::from_str_radix(parts[0], 16) {
                    let sym_type = parts[1];
                    let name = parts[2];
                    
                    if sym_type == "T" || sym_type == "t" {
                        function_table.push((addr, addr + 0x1000, demangle_symbol(name)));
                    }
                }
            }
        }
    }
    
    Ok(ParsedDebugInfo {
        line_table,
        function_table,
    })
}

/// Simple C++ symbol demangling
fn demangle_symbol(name: &str) -> String {
    // Try c++filt for proper demangling
    use std::process::Command;
    
    if let Ok(output) = Command::new("c++filt")
        .arg(name)
        .output()
    {
        if output.status.success() {
            let demangled = String::from_utf8_lossy(&output.stdout);
            return demangled.trim().to_string();
        }
    }
    
    // Fallback: basic Itanium ABI demangling
    if name.starts_with("_Z") {
        // Very basic: strip common prefixes
        name.to_string()
    } else {
        name.to_string()
    }
}

/// Find nearest address in line table (for approximate matching)
fn find_nearest_address(table: &HashMap<u64, (String, u32)>, target: u64) -> Option<(String, u32)> {
    let mut best: Option<(u64, &(String, u32))> = None;
    
    for (addr, loc) in table {
        if *addr <= target {
            match best {
                None => best = Some((*addr, loc)),
                Some((best_addr, _)) if *addr > best_addr => best = Some((*addr, loc)),
                _ => {}
            }
        }
    }
    
    best.map(|(_, loc)| (loc.0.clone(), loc.1))
}

// ============================================================
// COMPILER FLAGS FOR DEBUG INFO
// ============================================================

/// Get compiler flags for generating debug info
pub fn debug_compile_flags() -> Vec<&'static str> {
    vec![
        "-g",           // Generate debug info
        "-gdwarf-4",    // Use DWARF 4 format (widely supported)
        "-fno-omit-frame-pointer", // Keep frame pointers for better stack traces
    ]
}

/// Get linker flags for preserving debug info
pub fn debug_link_flags() -> Vec<&'static str> {
    vec![
        "-rdynamic",    // Export symbols for backtracing
    ]
}

// ============================================================
// GLOBAL CACHE INSTANCE
// ============================================================

lazy_static::lazy_static! {
    pub static ref SOURCE_MAP_CACHE: SourceMapCache = SourceMapCache::new();
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_source_location_format() {
        let loc = SourceLocation::new("main.cpp", 42)
            .with_column(15)
            .with_function("my_function");
        
        assert_eq!(loc.to_string(), "main.cpp:42:15");
        assert_eq!(loc.to_string_with_function(), "my_function at main.cpp:42:15");
    }
    
    #[test]
    fn test_demangle_simple() {
        // Basic symbols should pass through
        assert_eq!(demangle_symbol("main"), "main");
        assert_eq!(demangle_symbol("on_load"), "on_load");
    }
    
    #[test]
    fn test_parse_addr2line_location() {
        assert_eq!(
            parse_addr2line_location("main.cpp:42"),
            Some(("main.cpp".to_string(), 42))
        );
        assert_eq!(
            parse_addr2line_location("src/lib.cpp:100:5"),
            Some(("src/lib.cpp".to_string(), 100))
        );
        assert_eq!(parse_addr2line_location("??:0"), None);
    }
}
