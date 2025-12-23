// Host KV is actively used by runner_bin.rs for plugin key-value storage
// #![allow(dead_code)] - REMOVED: This module is now wired up
#![allow(static_mut_refs)]

// ============================================================
// HOST KV STORAGE MODULE
// ============================================================
// Provides persistent key-value storage for plugins across hot reloads.
//
// KEY FEATURES:
// - Per-namespace schema validation (Fast Refresh-like safety)
// - Schema mismatch triggers namespace reset, not full state reset
// - Quotas to prevent runaway storage
// - Thread-safe, session-scoped storage
//
// DESIGN RATIONALE:
// - Each module declares namespaces it uses via schema table exports
// - Schema ID changes trigger selective namespace reset
// - Modules can write/read only to declared namespaces (deterministic)
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_char, c_uint, c_void};
use std::ptr;
use std::sync::{Arc, Mutex, RwLock};

use crate::plugin_contract::ModuleSlot;

// ============================================================
// RETURN CODES
// ============================================================

/// KV operation return codes
pub const KV_OK: i32 = 0;
pub const KV_NOT_FOUND: i32 = 1;
pub const KV_INVALID_ARG: i32 = 2;
pub const KV_QUOTA_EXCEEDED: i32 = 3;
pub const KV_INTERNAL_ERROR: i32 = 4;

/// Human-readable error descriptions
pub fn error_string(code: i32) -> &'static str {
    match code {
        KV_OK => "OK",
        KV_NOT_FOUND => "Key not found",
        KV_INVALID_ARG => {
            "Invalid argument (bad namespace/key, null pointer, or undeclared namespace)"
        }
        KV_QUOTA_EXCEEDED => "Storage quota exceeded",
        KV_INTERNAL_ERROR => "Internal error",
        _ => "Unknown error",
    }
}

// ============================================================
// QUOTA CONFIGURATION
// ============================================================

/// Default quota limits
pub const DEFAULT_MAX_VALUE_BYTES: usize = 1_000_000; // 1 MB per value
pub const DEFAULT_MAX_KEYS_PER_NAMESPACE: usize = 2_000; // 2000 keys per namespace
pub const DEFAULT_MAX_TOTAL_BYTES_PER_MODULE: usize = 20_000_000; // 20 MB per (session, module_slot)
pub const MAX_NAMESPACES_DECLARED: usize = 128; // Max namespaces per module

/// Namespace/key validation constraints
pub const MAX_NAMESPACE_LEN: usize = 64;
pub const MAX_KEY_LEN: usize = 256;

/// Allowed characters in namespace/key: [a-zA-Z0-9._-]
fn is_valid_ns_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
}

/// Validate namespace or key string
pub fn validate_ns_or_key(s: &str, max_len: usize) -> Result<(), i32> {
    if s.is_empty() {
        return Err(KV_INVALID_ARG);
    }
    if s.len() > max_len {
        return Err(KV_INVALID_ARG);
    }
    if s.contains('/') || s.contains('\\') {
        return Err(KV_INVALID_ARG);
    }
    if !s.chars().all(is_valid_ns_key_char) {
        return Err(KV_INVALID_ARG);
    }
    Ok(())
}

// ============================================================
// C ABI STRUCTS
// ============================================================

/// ABI version for Host KV API
pub const HOST_KV_API_VERSION: u32 = 1;

/// Host Context passed to *_on_load_host functions
///
/// Layout (C ABI):
/// ```c
/// typedef struct SynthiHostContextV1 {
///     uint32_t host_api_version;      // Must be 1
///     const HostKvApiV1* kv;          // KV API vtable
///     const char* session_id;         // Session identifier
///     uint32_t session_id_len;        // Length of session_id
///     uint32_t module_slot;           // 0=core, 1=gui, 2=main
///     void* window;                   // SDL window (optional)
///     void* renderer;                 // SDL renderer
///     void* reserved[8];              // Future expansion
/// } SynthiHostContextV1;
/// ```
#[repr(C)]
pub struct SynthiHostContextV1 {
    pub host_api_version: c_uint,
    pub kv: *const HostKvApiV1,
    pub session_id: *const c_char,
    pub session_id_len: c_uint,
    pub module_slot: c_uint,
    pub window: *mut c_void,
    pub renderer: *mut c_void,
    pub reserved: [*mut c_void; 8],
}

impl SynthiHostContextV1 {
    /// Create a new host context
    pub fn new(
        kv_api: &HostKvApiV1,
        session_id: &std::ffi::CString,
        module_slot: ModuleSlot,
        window: *mut c_void,
        renderer: *mut c_void,
    ) -> Self {
        SynthiHostContextV1 {
            host_api_version: HOST_KV_API_VERSION,
            kv: kv_api as *const HostKvApiV1,
            session_id: session_id.as_ptr(),
            session_id_len: session_id.as_bytes().len() as c_uint,
            module_slot: module_slot_to_u32(module_slot),
            window,
            renderer,
            reserved: [ptr::null_mut(); 8],
        }
    }
}

/// Convert ModuleSlot to u32 for C ABI
pub fn module_slot_to_u32(slot: ModuleSlot) -> u32 {
    match slot {
        ModuleSlot::Core => 0,
        ModuleSlot::Gui => 1,
        ModuleSlot::Main => 2,
    }
}

/// Convert u32 to ModuleSlot
pub fn u32_to_module_slot(v: u32) -> Option<ModuleSlot> {
    match v {
        0 => Some(ModuleSlot::Core),
        1 => Some(ModuleSlot::Gui),
        2 => Some(ModuleSlot::Main),
        _ => None,
    }
}

/// KV API vtable
///
/// Layout (C ABI):
/// ```c
/// typedef struct HostKvApiV1 {
///     uint32_t version;
///     int (*set_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, const uint8_t* data, uint32_t len);
///     int (*get_bytes)(const SynthiHostContextV1* ctx, const char* ns, const char* key, uint8_t** out, uint32_t* out_len);
///     int (*delete_key)(const SynthiHostContextV1* ctx, const char* ns, const char* key);
///     int (*clear_namespace)(const SynthiHostContextV1* ctx, const char* ns);
///     int (*get_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t* out_schema);
///     int (*set_schema)(const SynthiHostContextV1* ctx, const char* ns, uint64_t schema);
///     void* (*host_alloc)(uint32_t size);
///     void (*host_free)(void* ptr);
///     const char* (*last_error)(void);
/// } HostKvApiV1;
/// ```
#[repr(C)]
pub struct HostKvApiV1 {
    pub version: c_uint,
    pub set_bytes: unsafe extern "C" fn(
        ctx: *const SynthiHostContextV1,
        ns: *const c_char,
        key: *const c_char,
        data: *const u8,
        len: c_uint,
    ) -> i32,
    pub get_bytes: unsafe extern "C" fn(
        ctx: *const SynthiHostContextV1,
        ns: *const c_char,
        key: *const c_char,
        out: *mut *mut u8,
        out_len: *mut c_uint,
    ) -> i32,
    pub delete_key: unsafe extern "C" fn(
        ctx: *const SynthiHostContextV1,
        ns: *const c_char,
        key: *const c_char,
    ) -> i32,
    pub clear_namespace:
        unsafe extern "C" fn(ctx: *const SynthiHostContextV1, ns: *const c_char) -> i32,
    pub get_schema: unsafe extern "C" fn(
        ctx: *const SynthiHostContextV1,
        ns: *const c_char,
        out_schema: *mut u64,
    ) -> i32,
    pub set_schema: unsafe extern "C" fn(
        ctx: *const SynthiHostContextV1,
        ns: *const c_char,
        schema: u64,
    ) -> i32,
    pub host_alloc: unsafe extern "C" fn(size: c_uint) -> *mut c_void,
    pub host_free: unsafe extern "C" fn(ptr: *mut c_void),
    pub last_error: unsafe extern "C" fn() -> *const c_char,
}

/// Namespace schema entry (exported by modules)
///
/// Layout (C ABI):
/// ```c
/// typedef struct SynthiNamespaceSchemaV1 {
///     const char* ns;       // NUL-terminated namespace name
///     uint64_t schema_id;   // Schema version/hash
/// } SynthiNamespaceSchemaV1;
/// ```
#[repr(C)]
#[derive(Debug, Clone)]
pub struct SynthiNamespaceSchemaV1 {
    pub ns: *const c_char,
    pub schema_id: u64,
}

// ============================================================
// STORAGE IMPLEMENTATION
// ============================================================

/// Namespace data with schema tracking
#[derive(Debug, Clone, Default)]
struct NamespaceData {
    /// Schema ID for this namespace
    schema_id: Option<u64>,
    /// Key-value pairs
    data: HashMap<String, Vec<u8>>,
    /// Total bytes used
    total_bytes: usize,
}

/// Per-module storage (scoped by session_id + module_slot)
#[derive(Debug, Clone, Default)]
struct ModuleStorage {
    /// Declared namespaces from schema table
    declared_namespaces: HashMap<String, u64>,
    /// Namespace data
    namespaces: HashMap<String, NamespaceData>,
    /// Total bytes across all namespaces
    total_bytes: usize,
}

/// Global KV store (thread-safe)
#[derive(Debug, Default)]
pub struct HostKvStore {
    /// Storage keyed by (session_id, module_slot)
    storage: RwLock<HashMap<(String, u32), ModuleStorage>>,
    /// Last error message (thread-local simulation via mutex)
    last_error: Mutex<String>,
    /// Quota configuration
    pub max_value_bytes: usize,
    pub max_keys_per_namespace: usize,
    pub max_total_bytes_per_module: usize,
}

impl HostKvStore {
    /// Create a new store with default quotas
    pub fn new() -> Self {
        HostKvStore {
            storage: RwLock::new(HashMap::new()),
            last_error: Mutex::new(String::new()),
            max_value_bytes: DEFAULT_MAX_VALUE_BYTES,
            max_keys_per_namespace: DEFAULT_MAX_KEYS_PER_NAMESPACE,
            max_total_bytes_per_module: DEFAULT_MAX_TOTAL_BYTES_PER_MODULE,
        }
    }

    /// Set the last error message
    fn set_error(&self, msg: &str) {
        if let Ok(mut err) = self.last_error.lock() {
            *err = msg.to_string();
        }
    }

    /// Get the last error message
    pub fn get_last_error(&self) -> String {
        self.last_error
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default()
    }

    /// Register declared namespaces from module's schema table
    pub fn register_schemas(
        &self,
        session_id: &str,
        module_slot: u32,
        schemas: &[(String, u64)],
    ) -> Vec<HostKvSchemaEvent> {
        let mut events = Vec::new();
        let key = (session_id.to_string(), module_slot);

        let mut storage = self.storage.write().unwrap();
        let module_storage = storage.entry(key).or_default();

        for (ns, new_schema_id) in schemas {
            // Validate namespace name
            if validate_ns_or_key(ns, MAX_NAMESPACE_LEN).is_err() {
                events.push(HostKvSchemaEvent::InvalidNamespace {
                    namespace: ns.clone(),
                    reason: "Invalid namespace name".to_string(),
                });
                continue;
            }

            let old_schema = module_storage.declared_namespaces.get(ns).copied();

            match old_schema {
                None => {
                    // New namespace, just store schema
                    module_storage
                        .declared_namespaces
                        .insert(ns.clone(), *new_schema_id);
                    module_storage
                        .namespaces
                        .entry(ns.clone())
                        .or_default()
                        .schema_id = Some(*new_schema_id);
                    events.push(HostKvSchemaEvent::NamespaceRegistered {
                        namespace: ns.clone(),
                        schema_id: *new_schema_id,
                    });
                }
                Some(old_id) if old_id != *new_schema_id => {
                    // Schema mismatch - clear namespace and update schema
                    if let Some(ns_data) = module_storage.namespaces.get_mut(ns) {
                        module_storage.total_bytes -= ns_data.total_bytes;
                        ns_data.data.clear();
                        ns_data.total_bytes = 0;
                        ns_data.schema_id = Some(*new_schema_id);
                    }
                    module_storage
                        .declared_namespaces
                        .insert(ns.clone(), *new_schema_id);
                    events.push(HostKvSchemaEvent::SchemaMismatchReset {
                        namespace: ns.clone(),
                        old_schema: old_id,
                        new_schema: *new_schema_id,
                    });
                }
                Some(_) => {
                    // Schema unchanged, preserve data
                    events.push(HostKvSchemaEvent::NamespacePreserved {
                        namespace: ns.clone(),
                    });
                }
            }
        }

        events
    }

    /// Check if namespace is declared for this module
    fn is_namespace_declared(&self, session_id: &str, module_slot: u32, ns: &str) -> bool {
        let key = (session_id.to_string(), module_slot);
        let storage = self.storage.read().unwrap();
        storage
            .get(&key)
            .map(|m| m.declared_namespaces.contains_key(ns))
            .unwrap_or(false)
    }

    /// Set bytes for a key
    pub fn set_bytes(
        &self,
        session_id: &str,
        module_slot: u32,
        ns: &str,
        key: &str,
        data: &[u8],
    ) -> i32 {
        // Validate inputs
        if let Err(code) = validate_ns_or_key(ns, MAX_NAMESPACE_LEN) {
            self.set_error("Invalid namespace name");
            return code;
        }
        if let Err(code) = validate_ns_or_key(key, MAX_KEY_LEN) {
            self.set_error("Invalid key name");
            return code;
        }

        // Check namespace is declared
        if !self.is_namespace_declared(session_id, module_slot, ns) {
            self.set_error("Undeclared namespace - must export in schema table");
            return KV_INVALID_ARG;
        }

        // Check value size quota
        if data.len() > self.max_value_bytes {
            self.set_error(&format!(
                "Value size {} exceeds max {}",
                data.len(),
                self.max_value_bytes
            ));
            return KV_QUOTA_EXCEEDED;
        }

        let storage_key = (session_id.to_string(), module_slot);
        let mut storage = self.storage.write().unwrap();
        let module_storage = storage.entry(storage_key).or_default();
        let ns_data = module_storage.namespaces.entry(ns.to_string()).or_default();

        // Check keys per namespace quota
        if !ns_data.data.contains_key(key) && ns_data.data.len() >= self.max_keys_per_namespace {
            self.set_error(&format!(
                "Keys per namespace {} exceeds max {}",
                ns_data.data.len(),
                self.max_keys_per_namespace
            ));
            return KV_QUOTA_EXCEEDED;
        }

        // Calculate size delta
        let old_size = ns_data.data.get(key).map(|v| v.len()).unwrap_or(0);
        let size_delta = data.len() as isize - old_size as isize;

        // Check total bytes quota
        let new_total = (module_storage.total_bytes as isize + size_delta) as usize;
        if new_total > self.max_total_bytes_per_module {
            self.set_error(&format!(
                "Total bytes {} exceeds max {}",
                new_total, self.max_total_bytes_per_module
            ));
            return KV_QUOTA_EXCEEDED;
        }

        // Update storage
        ns_data.data.insert(key.to_string(), data.to_vec());
        ns_data.total_bytes = (ns_data.total_bytes as isize + size_delta) as usize;
        module_storage.total_bytes = new_total;

        KV_OK
    }

    /// Get bytes for a key (returns owned copy)
    pub fn get_bytes(
        &self,
        session_id: &str,
        module_slot: u32,
        ns: &str,
        key: &str,
    ) -> Result<Vec<u8>, i32> {
        // Validate inputs
        validate_ns_or_key(ns, MAX_NAMESPACE_LEN).map_err(|_| {
            self.set_error("Invalid namespace name");
            KV_INVALID_ARG
        })?;
        validate_ns_or_key(key, MAX_KEY_LEN).map_err(|_| {
            self.set_error("Invalid key name");
            KV_INVALID_ARG
        })?;

        // Check namespace is declared
        if !self.is_namespace_declared(session_id, module_slot, ns) {
            self.set_error("Undeclared namespace");
            return Err(KV_INVALID_ARG);
        }

        let storage_key = (session_id.to_string(), module_slot);
        let storage = self.storage.read().unwrap();

        storage
            .get(&storage_key)
            .and_then(|m| m.namespaces.get(ns))
            .and_then(|n| n.data.get(key))
            .cloned()
            .ok_or_else(|| {
                self.set_error("Key not found");
                KV_NOT_FOUND
            })
    }

    /// Delete a key (idempotent - returns OK even if key doesn't exist)
    pub fn delete_key(&self, session_id: &str, module_slot: u32, ns: &str, key: &str) -> i32 {
        // Validate inputs
        if let Err(code) = validate_ns_or_key(ns, MAX_NAMESPACE_LEN) {
            self.set_error("Invalid namespace name");
            return code;
        }
        if let Err(code) = validate_ns_or_key(key, MAX_KEY_LEN) {
            self.set_error("Invalid key name");
            return code;
        }

        // Check namespace is declared
        if !self.is_namespace_declared(session_id, module_slot, ns) {
            self.set_error("Undeclared namespace");
            return KV_INVALID_ARG;
        }

        let storage_key = (session_id.to_string(), module_slot);
        let mut storage = self.storage.write().unwrap();

        if let Some(module_storage) = storage.get_mut(&storage_key) {
            if let Some(ns_data) = module_storage.namespaces.get_mut(ns) {
                if let Some(old_data) = ns_data.data.remove(key) {
                    ns_data.total_bytes -= old_data.len();
                    module_storage.total_bytes -= old_data.len();
                }
            }
        }

        KV_OK // Idempotent - always OK
    }

    /// Clear all keys in a namespace
    pub fn clear_namespace(&self, session_id: &str, module_slot: u32, ns: &str) -> i32 {
        // Validate inputs
        if let Err(code) = validate_ns_or_key(ns, MAX_NAMESPACE_LEN) {
            self.set_error("Invalid namespace name");
            return code;
        }

        // Check namespace is declared
        if !self.is_namespace_declared(session_id, module_slot, ns) {
            self.set_error("Undeclared namespace");
            return KV_INVALID_ARG;
        }

        let storage_key = (session_id.to_string(), module_slot);
        let mut storage = self.storage.write().unwrap();

        if let Some(module_storage) = storage.get_mut(&storage_key) {
            if let Some(ns_data) = module_storage.namespaces.get_mut(ns) {
                module_storage.total_bytes -= ns_data.total_bytes;
                ns_data.data.clear();
                ns_data.total_bytes = 0;
            }
        }

        KV_OK
    }

    /// Get schema ID for a namespace
    pub fn get_schema(&self, session_id: &str, module_slot: u32, ns: &str) -> Result<u64, i32> {
        let storage_key = (session_id.to_string(), module_slot);
        let storage = self.storage.read().unwrap();

        storage
            .get(&storage_key)
            .and_then(|m| m.declared_namespaces.get(ns))
            .copied()
            .ok_or_else(|| {
                self.set_error("Namespace not found");
                KV_NOT_FOUND
            })
    }

    /// Get list of preserved namespaces for HMR status reporting
    pub fn get_preserved_namespaces(&self, session_id: &str, module_slot: u32) -> Vec<String> {
        let storage_key = (session_id.to_string(), module_slot);
        let storage = self.storage.read().unwrap();

        storage
            .get(&storage_key)
            .map(|m| {
                m.namespaces
                    .iter()
                    .filter(|(_, data)| !data.data.is_empty())
                    .map(|(ns, _)| ns.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    // ============================================================
    // PERSISTENCE (Cross-Session State)
    // ============================================================

    /// Serialize all storage to a JSON string for disk persistence
    pub fn serialize_to_json(&self) -> Result<String, String> {
        let storage = self
            .storage
            .read()
            .map_err(|e| format!("Lock error: {}", e))?;

        // Convert to serializable format
        let mut serializable: HashMap<String, SerializableModuleStorage> = HashMap::new();

        for ((session_id, module_slot), module_storage) in storage.iter() {
            let key = format!("{}:{}", session_id, module_slot);

            let mut namespaces = HashMap::new();
            for (ns_name, ns_data) in &module_storage.namespaces {
                // Convert bytes to base64 for JSON serialization
                let mut data: HashMap<String, String> = HashMap::new();
                for (k, v) in &ns_data.data {
                    data.insert(k.clone(), base64_encode(v));
                }

                namespaces.insert(
                    ns_name.clone(),
                    SerializableNamespaceData {
                        schema_id: ns_data.schema_id,
                        data,
                        total_bytes: ns_data.total_bytes,
                    },
                );
            }

            serializable.insert(
                key,
                SerializableModuleStorage {
                    declared_namespaces: module_storage.declared_namespaces.clone(),
                    namespaces,
                    total_bytes: module_storage.total_bytes,
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                },
            );
        }

        serde_json::to_string_pretty(&serializable)
            .map_err(|e| format!("Serialization error: {}", e))
    }

    /// Deserialize storage from a JSON string
    pub fn deserialize_from_json(&self, json: &str) -> Result<usize, String> {
        let serializable: HashMap<String, SerializableModuleStorage> =
            serde_json::from_str(json).map_err(|e| format!("Parse error: {}", e))?;

        let mut storage = self
            .storage
            .write()
            .map_err(|e| format!("Lock error: {}", e))?;
        let mut loaded_count = 0;

        for (key, ser_storage) in serializable {
            // Parse key "session_id:module_slot"
            let parts: Vec<&str> = key.rsplitn(2, ':').collect();
            if parts.len() != 2 {
                continue;
            }

            let module_slot: u32 = match parts[0].parse() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let session_id = parts[1].to_string();

            // Convert back from serializable format
            let mut namespaces = HashMap::new();
            for (ns_name, ser_ns) in ser_storage.namespaces {
                let mut data: HashMap<String, Vec<u8>> = HashMap::new();
                for (k, v) in ser_ns.data {
                    if let Some(decoded) = base64_decode(&v) {
                        data.insert(k, decoded);
                    }
                }

                namespaces.insert(
                    ns_name,
                    NamespaceData {
                        schema_id: ser_ns.schema_id,
                        data,
                        total_bytes: ser_ns.total_bytes,
                    },
                );
            }

            let module_storage = ModuleStorage {
                declared_namespaces: ser_storage.declared_namespaces,
                namespaces,
                total_bytes: ser_storage.total_bytes,
            };

            storage.insert((session_id, module_slot), module_storage);
            loaded_count += 1;
        }

        Ok(loaded_count)
    }

    /// Save storage to a file
    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), String> {
        let json = self.serialize_to_json()?;
        std::fs::write(path, json).map_err(|e| format!("Write error: {}", e))
    }

    /// Load storage from a file
    pub fn load_from_file(&self, path: &std::path::Path) -> Result<usize, String> {
        let json = std::fs::read_to_string(path).map_err(|e| format!("Read error: {}", e))?;
        self.deserialize_from_json(&json)
    }

    /// Clean up stale sessions (older than TTL)
    pub fn cleanup_stale_sessions(&self, ttl_secs: u64) -> usize {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // For cleanup, we'd need to track timestamps per session
        // This is a simplified version that just clears all data
        // In production, you'd track last-access timestamps

        // Note: This is a placeholder. Full implementation would require
        // tracking access timestamps per (session_id, module_slot)
        let _ = ttl_secs;
        let _ = now;
        0
    }

    /// Get statistics about stored data
    pub fn get_stats(&self) -> KvStoreStats {
        let storage = self.storage.read().unwrap();

        let mut total_sessions = std::collections::HashSet::new();
        let mut total_namespaces = 0;
        let mut total_keys = 0;
        let mut total_bytes = 0usize;

        for ((session_id, _), module_storage) in storage.iter() {
            total_sessions.insert(session_id.clone());

            for (_, ns_data) in &module_storage.namespaces {
                total_namespaces += 1;
                total_keys += ns_data.data.len();
                total_bytes += ns_data.total_bytes;
            }
        }

        KvStoreStats {
            session_count: total_sessions.len(),
            module_count: storage.len(),
            namespace_count: total_namespaces,
            key_count: total_keys,
            total_bytes,
        }
    }
}

/// Statistics about KV store
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvStoreStats {
    pub session_count: usize,
    pub module_count: usize,
    pub namespace_count: usize,
    pub key_count: usize,
    pub total_bytes: usize,
}

/// Serializable version of NamespaceData (bytes as base64)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SerializableNamespaceData {
    schema_id: Option<u64>,
    data: HashMap<String, String>, // key -> base64-encoded value
    total_bytes: usize,
}

/// Serializable version of ModuleStorage
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SerializableModuleStorage {
    declared_namespaces: HashMap<String, u64>,
    namespaces: HashMap<String, SerializableNamespaceData>,
    total_bytes: usize,
    timestamp: u64, // Last modification time
}

/// Simple base64 encoding
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = data.get(i + 1).copied().unwrap_or(0) as usize;
        let b2 = data.get(i + 2).copied().unwrap_or(0) as usize;

        result.push(ALPHABET[(b0 >> 2) & 0x3F] as char);
        result.push(ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);

        if i + 1 < data.len() {
            result.push(ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3F] as char);
        } else {
            result.push('=');
        }

        if i + 2 < data.len() {
            result.push(ALPHABET[b2 & 0x3F] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    result
}

/// Simple base64 decoding
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const DECODE: [i8; 128] = [
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1,
        -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4,
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1,
        -1, -1, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
        46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
    ];

    let bytes: Vec<u8> = s.bytes().filter(|&b| b != b'=').collect();
    let mut result = Vec::with_capacity(bytes.len() * 3 / 4);

    let mut i = 0;
    while i + 3 < bytes.len() {
        let b0 = DECODE.get(bytes[i] as usize).copied().unwrap_or(-1);
        let b1 = DECODE.get(bytes[i + 1] as usize).copied().unwrap_or(-1);
        let b2 = DECODE.get(bytes[i + 2] as usize).copied().unwrap_or(-1);
        let b3 = DECODE.get(bytes[i + 3] as usize).copied().unwrap_or(-1);

        if b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0 {
            return None;
        }

        result.push(((b0 << 2) | (b1 >> 4)) as u8);
        result.push(((b1 << 4) | (b2 >> 2)) as u8);
        result.push(((b2 << 6) | b3) as u8);

        i += 4;
    }

    // Handle remaining bytes
    if i + 1 < bytes.len() {
        let b0 = DECODE.get(bytes[i] as usize).copied().unwrap_or(-1);
        let b1 = DECODE.get(bytes[i + 1] as usize).copied().unwrap_or(-1);

        if b0 >= 0 && b1 >= 0 {
            result.push(((b0 << 2) | (b1 >> 4)) as u8);

            if i + 2 < bytes.len() {
                let b2 = DECODE.get(bytes[i + 2] as usize).copied().unwrap_or(-1);
                if b2 >= 0 {
                    result.push(((b1 << 4) | (b2 >> 2)) as u8);
                }
            }
        }
    }

    Some(result)
}

// ============================================================
// SCHEMA EVENTS (for HMR status reporting)
// ============================================================

/// Events from schema registration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostKvSchemaEvent {
    /// New namespace registered
    NamespaceRegistered { namespace: String, schema_id: u64 },
    /// Namespace preserved (schema unchanged)
    NamespacePreserved { namespace: String },
    /// Schema mismatch - namespace was reset
    SchemaMismatchReset {
        namespace: String,
        old_schema: u64,
        new_schema: u64,
    },
    /// Invalid namespace name
    InvalidNamespace { namespace: String, reason: String },
}

// ============================================================
// GLOBAL STORE INSTANCE
// ============================================================

lazy_static::lazy_static! {
    /// Global KV store instance
    pub static ref KV_STORE: Arc<HostKvStore> = Arc::new(HostKvStore::new());
}

// ============================================================
// C ABI FUNCTION IMPLEMENTATIONS
// ============================================================

/// Extract session_id and module_slot from context
unsafe fn ctx_to_key(ctx: *const SynthiHostContextV1) -> Option<(String, u32)> {
    if ctx.is_null() {
        return None;
    }
    let ctx_ref = &*ctx;
    if ctx_ref.session_id.is_null() {
        return None;
    }
    let session_id = std::ffi::CStr::from_ptr(ctx_ref.session_id)
        .to_str()
        .ok()?
        .to_string();
    Some((session_id, ctx_ref.module_slot))
}

/// C ABI: Set bytes
pub unsafe extern "C" fn kv_set_bytes(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
    key: *const c_char,
    data: *const u8,
    len: c_uint,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() || key.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };
    let key_str = match std::ffi::CStr::from_ptr(key).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    let data_slice = if data.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(data, len as usize)
    };

    KV_STORE.set_bytes(&session_id, module_slot, ns_str, key_str, data_slice)
}

/// C ABI: Get bytes (allocates output buffer)
pub unsafe extern "C" fn kv_get_bytes(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
    key: *const c_char,
    out: *mut *mut u8,
    out_len: *mut c_uint,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() || key.is_null() || out.is_null() || out_len.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };
    let key_str = match std::ffi::CStr::from_ptr(key).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    match KV_STORE.get_bytes(&session_id, module_slot, ns_str, key_str) {
        Ok(data) => {
            let ptr = libc::malloc(data.len()) as *mut u8;
            if ptr.is_null() {
                return KV_INTERNAL_ERROR;
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            *out = ptr;
            *out_len = data.len() as c_uint;
            KV_OK
        }
        Err(code) => code,
    }
}

/// C ABI: Delete key
pub unsafe extern "C" fn kv_delete_key(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
    key: *const c_char,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() || key.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };
    let key_str = match std::ffi::CStr::from_ptr(key).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    KV_STORE.delete_key(&session_id, module_slot, ns_str, key_str)
}

/// C ABI: Clear namespace
pub unsafe extern "C" fn kv_clear_namespace(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    KV_STORE.clear_namespace(&session_id, module_slot, ns_str)
}

/// C ABI: Get schema
pub unsafe extern "C" fn kv_get_schema(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
    out_schema: *mut u64,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() || out_schema.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    match KV_STORE.get_schema(&session_id, module_slot, ns_str) {
        Ok(schema) => {
            *out_schema = schema;
            KV_OK
        }
        Err(code) => code,
    }
}

/// C ABI: Set schema (optional - schema comes from exports, but allow runtime override)
pub unsafe extern "C" fn kv_set_schema(
    ctx: *const SynthiHostContextV1,
    ns: *const c_char,
    schema: u64,
) -> i32 {
    let Some((session_id, module_slot)) = ctx_to_key(ctx) else {
        return KV_INVALID_ARG;
    };

    if ns.is_null() {
        return KV_INVALID_ARG;
    }

    let ns_str = match std::ffi::CStr::from_ptr(ns).to_str() {
        Ok(s) => s,
        Err(_) => return KV_INVALID_ARG,
    };

    // Register single schema
    let _ = KV_STORE.register_schemas(&session_id, module_slot, &[(ns_str.to_string(), schema)]);
    KV_OK
}

/// C ABI: Allocate memory (for plugin to allocate buffers)
pub unsafe extern "C" fn kv_host_alloc(size: c_uint) -> *mut c_void {
    libc::malloc(size as usize)
}

/// C ABI: Free memory
pub unsafe extern "C" fn kv_host_free(ptr: *mut c_void) {
    if !ptr.is_null() {
        libc::free(ptr);
    }
}

/// C ABI: Get last error message
pub unsafe extern "C" fn kv_last_error() -> *const c_char {
    // Return a static error string based on current state
    // In production, this would be thread-local
    static mut LAST_ERROR_BUF: [u8; 256] = [0; 256];

    let msg = KV_STORE.get_last_error();
    let bytes = msg.as_bytes();
    let len = bytes.len().min(255);

    LAST_ERROR_BUF[..len].copy_from_slice(&bytes[..len]);
    LAST_ERROR_BUF[len] = 0;

    LAST_ERROR_BUF.as_ptr() as *const c_char
}

/// Create the KV API vtable
pub fn create_kv_api() -> HostKvApiV1 {
    HostKvApiV1 {
        version: HOST_KV_API_VERSION,
        set_bytes: kv_set_bytes,
        get_bytes: kv_get_bytes,
        delete_key: kv_delete_key,
        clear_namespace: kv_clear_namespace,
        get_schema: kv_get_schema,
        set_schema: kv_set_schema,
        host_alloc: kv_host_alloc,
        host_free: kv_host_free,
        last_error: kv_last_error,
    }
}

// ============================================================
// SCHEMA TABLE READING
// ============================================================

use libloading::{Library, Symbol};

/// Read schema table from a loaded library
///
/// Looks for:
/// - *_host_kv_schemas_len() -> uint32_t
/// - *_host_kv_schemas() -> const SynthiNamespaceSchemaV1*
pub fn read_schema_table(lib: &Library, module_slot: ModuleSlot) -> Vec<(String, u64)> {
    let prefix = match module_slot {
        ModuleSlot::Core => "core",
        ModuleSlot::Gui => "gui",
        ModuleSlot::Main => "",
    };

    let len_symbol_name = if prefix.is_empty() {
        "host_kv_schemas_len".to_string()
    } else {
        format!("{}_host_kv_schemas_len", prefix)
    };

    let ptr_symbol_name = if prefix.is_empty() {
        "host_kv_schemas".to_string()
    } else {
        format!("{}_host_kv_schemas", prefix)
    };

    type LenFn = unsafe extern "C" fn() -> c_uint;
    type PtrFn = unsafe extern "C" fn() -> *const SynthiNamespaceSchemaV1;

    let mut schemas = Vec::new();

    unsafe {
        let len_fn: Result<Symbol<LenFn>, _> = lib.get(len_symbol_name.as_bytes());
        let ptr_fn: Result<Symbol<PtrFn>, _> = lib.get(ptr_symbol_name.as_bytes());

        if let (Ok(get_len), Ok(get_ptr)) = (len_fn, ptr_fn) {
            let count = get_len() as usize;

            // Cap at max to prevent malicious modules
            let count = count.min(MAX_NAMESPACES_DECLARED);

            if count > 0 {
                let ptr = get_ptr();
                if !ptr.is_null() {
                    let entries = std::slice::from_raw_parts(ptr, count);

                    for entry in entries {
                        if !entry.ns.is_null() {
                            if let Ok(ns) = std::ffi::CStr::from_ptr(entry.ns).to_str() {
                                // Validate namespace name
                                if validate_ns_or_key(ns, MAX_NAMESPACE_LEN).is_ok() {
                                    schemas.push((ns.to_string(), entry.schema_id));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    schemas
}

// ============================================================
// HMR STATUS EVENTS
// ============================================================

/// HMR status events for Host KV
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum HostKvHmrStatus {
    /// Host KV is ready (session set, context available)
    HostKvReady {
        session_id: String,
        module_slot: String,
    },
    /// Namespaces preserved on reload
    HostKvPreserved {
        module: String,
        namespaces: Vec<String>,
    },
    /// Schema mismatch caused namespace reset
    HostKvResetSchemaMismatch {
        module: String,
        namespace: String,
        old_schema: u64,
        new_schema: u64,
    },
    /// Write rejected (quota or invalid namespace)
    HostKvWriteRejected {
        module: String,
        namespace: String,
        key: String,
        reason: String,
    },
}

impl HostKvHmrStatus {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_ns_or_key() {
        assert!(validate_ns_or_key("app", MAX_NAMESPACE_LEN).is_ok());
        assert!(validate_ns_or_key("app_state", MAX_NAMESPACE_LEN).is_ok());
        assert!(validate_ns_or_key("app-state", MAX_NAMESPACE_LEN).is_ok());
        assert!(validate_ns_or_key("app.state", MAX_NAMESPACE_LEN).is_ok());
        assert!(validate_ns_or_key("App123", MAX_NAMESPACE_LEN).is_ok());

        // Invalid cases
        assert!(validate_ns_or_key("", MAX_NAMESPACE_LEN).is_err());
        assert!(validate_ns_or_key("app/state", MAX_NAMESPACE_LEN).is_err());
        assert!(validate_ns_or_key("app\\state", MAX_NAMESPACE_LEN).is_err());
        assert!(validate_ns_or_key("app state", MAX_NAMESPACE_LEN).is_err());

        // Too long
        let long_name = "a".repeat(MAX_NAMESPACE_LEN + 1);
        assert!(validate_ns_or_key(&long_name, MAX_NAMESPACE_LEN).is_err());
    }

    #[test]
    fn test_kv_store_basic_operations() {
        let store = HostKvStore::new();
        let session = "test-session";
        let slot = 0;

        // Register namespace
        store.register_schemas(session, slot, &[("app".to_string(), 1)]);

        // Set and get
        assert_eq!(
            store.set_bytes(session, slot, "app", "key1", b"value1"),
            KV_OK
        );
        assert_eq!(
            store.get_bytes(session, slot, "app", "key1"),
            Ok(b"value1".to_vec())
        );

        // Update
        assert_eq!(
            store.set_bytes(session, slot, "app", "key1", b"value2"),
            KV_OK
        );
        assert_eq!(
            store.get_bytes(session, slot, "app", "key1"),
            Ok(b"value2".to_vec())
        );

        // Delete
        assert_eq!(store.delete_key(session, slot, "app", "key1"), KV_OK);
        assert_eq!(
            store.get_bytes(session, slot, "app", "key1"),
            Err(KV_NOT_FOUND)
        );

        // Delete non-existent (idempotent)
        assert_eq!(store.delete_key(session, slot, "app", "key1"), KV_OK);
    }

    #[test]
    fn test_undeclared_namespace_rejected() {
        let store = HostKvStore::new();
        let session = "test-session";
        let slot = 0;

        // No namespace registered
        assert_eq!(
            store.set_bytes(session, slot, "app", "key1", b"value1"),
            KV_INVALID_ARG
        );
    }

    #[test]
    fn test_schema_mismatch_clears_namespace() {
        let store = HostKvStore::new();
        let session = "test-session";
        let slot = 0;

        // Register and write
        store.register_schemas(session, slot, &[("app".to_string(), 1)]);
        store.set_bytes(session, slot, "app", "key1", b"value1");
        assert_eq!(
            store.get_bytes(session, slot, "app", "key1"),
            Ok(b"value1".to_vec())
        );

        // Change schema - should clear
        let events = store.register_schemas(session, slot, &[("app".to_string(), 2)]);

        // Should have reset event
        assert!(events
            .iter()
            .any(|e| matches!(e, HostKvSchemaEvent::SchemaMismatchReset { .. })));

        // Data should be gone
        assert_eq!(
            store.get_bytes(session, slot, "app", "key1"),
            Err(KV_NOT_FOUND)
        );
    }

    #[test]
    fn test_quota_enforcement() {
        let mut store = HostKvStore::new();
        store.max_value_bytes = 10; // Very small for testing

        let session = "test-session";
        let slot = 0;

        store.register_schemas(session, slot, &[("app".to_string(), 1)]);

        // Should fail - too large
        assert_eq!(
            store.set_bytes(session, slot, "app", "key1", &[0u8; 20]),
            KV_QUOTA_EXCEEDED
        );

        // Should succeed
        assert_eq!(
            store.set_bytes(session, slot, "app", "key1", &[0u8; 5]),
            KV_OK
        );
    }
}

// ============================================================
// AUTO-PERSISTENCE SYSTEM
// ============================================================
// Provides automatic persistence for cross-session state recovery
// ============================================================

/// Configuration for auto-persistence
#[derive(Debug, Clone)]
pub struct AutoPersistConfig {
    /// Directory to store persistence files
    pub persistence_dir: std::path::PathBuf,
    /// Whether auto-persist is enabled
    pub enabled: bool,
    /// Debounce interval for writes (ms)
    pub debounce_ms: u64,
    /// Maximum file age before cleanup (seconds)
    pub max_file_age_secs: u64,
}

impl Default for AutoPersistConfig {
    fn default() -> Self {
        Self {
            persistence_dir: std::path::PathBuf::from(".synthi_kv_persistence"),
            enabled: true,
            debounce_ms: 1000,        // 1 second debounce
            max_file_age_secs: 86400, // 24 hours
        }
    }
}

/// Manager for automatic Host KV persistence across IDE restarts
pub struct AutoPersistManager {
    config: AutoPersistConfig,
    /// Last save timestamps per session
    last_save: std::sync::RwLock<HashMap<String, std::time::Instant>>,
    /// Dirty sessions that need saving
    dirty_sessions: std::sync::RwLock<std::collections::HashSet<String>>,
}

impl AutoPersistManager {
    /// Create a new auto-persist manager
    pub fn new(config: AutoPersistConfig) -> std::io::Result<Self> {
        if config.enabled {
            // Ensure persistence directory exists
            std::fs::create_dir_all(&config.persistence_dir)?;
        }

        Ok(Self {
            config,
            last_save: std::sync::RwLock::new(HashMap::new()),
            dirty_sessions: std::sync::RwLock::new(std::collections::HashSet::new()),
        })
    }

    /// Create with default config
    pub fn new_default() -> std::io::Result<Self> {
        Self::new(AutoPersistConfig::default())
    }

    /// Get the persistence file path for a session
    fn session_file_path(&self, session_id: &str) -> std::path::PathBuf {
        self.config
            .persistence_dir
            .join(format!("{}.kv.json", session_id))
    }

    /// Mark a session as dirty (needs saving)
    pub fn mark_dirty(&self, session_id: &str) {
        if self.config.enabled {
            if let Ok(mut dirty) = self.dirty_sessions.write() {
                dirty.insert(session_id.to_string());
            }
        }
    }

    /// Check if a session needs saving and enough time has passed
    fn should_save(&self, session_id: &str) -> bool {
        if !self.config.enabled {
            return false;
        }

        let is_dirty = self
            .dirty_sessions
            .read()
            .map(|d| d.contains(session_id))
            .unwrap_or(false);

        if !is_dirty {
            return false;
        }

        // Check debounce
        if let Ok(last_save) = self.last_save.read() {
            if let Some(last) = last_save.get(session_id) {
                if last.elapsed() < std::time::Duration::from_millis(self.config.debounce_ms) {
                    return false;
                }
            }
        }

        true
    }

    /// Save a session's state to disk
    pub fn save_session(&self, store: &HostKvStore, session_id: &str) -> Result<(), String> {
        if !self.config.enabled {
            return Ok(());
        }

        let path = self.session_file_path(session_id);
        let json = store.serialize_to_json()?;

        std::fs::write(&path, &json)
            .map_err(|e| format!("Failed to write persistence file: {}", e))?;

        // Update last save time
        if let Ok(mut last_save) = self.last_save.write() {
            last_save.insert(session_id.to_string(), std::time::Instant::now());
        }

        // Clear dirty flag
        if let Ok(mut dirty) = self.dirty_sessions.write() {
            dirty.remove(session_id);
        }

        eprintln!(
            "[Host KV] Persisted session {} to {}",
            session_id,
            path.display()
        );
        Ok(())
    }

    /// Load a session's state from disk
    pub fn load_session(&self, store: &HostKvStore, session_id: &str) -> Result<bool, String> {
        if !self.config.enabled {
            return Ok(false);
        }

        let path = self.session_file_path(session_id);

        if !path.exists() {
            return Ok(false);
        }

        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read persistence file: {}", e))?;

        let count = store.deserialize_from_json(&json)?;

        eprintln!(
            "[Host KV] Restored {} entries for session {} from {}",
            count,
            session_id,
            path.display()
        );

        Ok(true)
    }

    /// Check and save dirty sessions (call periodically)
    pub fn flush_dirty(&self, store: &HostKvStore) {
        if !self.config.enabled {
            return;
        }

        let sessions_to_save: Vec<String> = {
            self.dirty_sessions
                .read()
                .map(|d| d.iter().cloned().collect())
                .unwrap_or_default()
        };

        for session_id in sessions_to_save {
            if self.should_save(&session_id) {
                if let Err(e) = self.save_session(store, &session_id) {
                    eprintln!("[Host KV] Failed to persist session {}: {}", session_id, e);
                }
            }
        }
    }

    /// Save all dirty sessions immediately (call on shutdown)
    pub fn save_all(&self, store: &HostKvStore) {
        if !self.config.enabled {
            return;
        }

        let sessions_to_save: Vec<String> = {
            self.dirty_sessions
                .read()
                .map(|d| d.iter().cloned().collect())
                .unwrap_or_default()
        };

        for session_id in sessions_to_save {
            if let Err(e) = self.save_session(store, &session_id) {
                eprintln!(
                    "[Host KV] Failed to persist session {} on shutdown: {}",
                    session_id, e
                );
            }
        }
    }

    /// Load all sessions from disk on startup
    pub fn load_all(&self, store: &HostKvStore) -> Result<usize, String> {
        if !self.config.enabled {
            return Ok(0);
        }

        let mut total = 0;

        if let Ok(entries) = std::fs::read_dir(&self.config.persistence_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let session_id = stem.trim_end_matches(".kv");
                        match self.load_session(store, session_id) {
                            Ok(true) => total += 1,
                            Ok(false) => {}
                            Err(e) => {
                                eprintln!("[Host KV] Failed to load {}: {}", path.display(), e)
                            }
                        }
                    }
                }
            }
        }

        Ok(total)
    }

    /// Clean up old persistence files
    pub fn cleanup_old_files(&self) -> Result<usize, String> {
        if !self.config.enabled {
            return Ok(0);
        }

        let max_age = std::time::Duration::from_secs(self.config.max_file_age_secs);
        let mut removed = 0;

        if let Ok(entries) = std::fs::read_dir(&self.config.persistence_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(age) = modified.elapsed() {
                            if age > max_age {
                                if std::fs::remove_file(&path).is_ok() {
                                    removed += 1;
                                    eprintln!("[Host KV] Cleaned up old file: {}", path.display());
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(removed)
    }
}

impl Default for AutoPersistManager {
    fn default() -> Self {
        Self::new_default().unwrap_or_else(|_| Self {
            config: AutoPersistConfig {
                enabled: false,
                ..Default::default()
            },
            last_save: std::sync::RwLock::new(HashMap::new()),
            dirty_sessions: std::sync::RwLock::new(std::collections::HashSet::new()),
        })
    }
}

lazy_static::lazy_static! {
    /// Global auto-persist manager instance
    pub static ref AUTO_PERSIST: AutoPersistManager = AutoPersistManager::default();
}

/// Initialize auto-persistence on startup
pub fn init_auto_persistence() -> Result<usize, String> {
    AUTO_PERSIST.load_all(&KV_STORE)
}

/// Save all state on shutdown
pub fn shutdown_auto_persistence() {
    AUTO_PERSIST.save_all(&KV_STORE);
}

/// Mark a session as modified (trigger eventual persistence)
pub fn mark_session_dirty(session_id: &str) {
    AUTO_PERSIST.mark_dirty(session_id);
}

/// Force immediate save of a session
pub fn persist_session_now(session_id: &str) -> Result<(), String> {
    AUTO_PERSIST.save_session(&KV_STORE, session_id)
}
