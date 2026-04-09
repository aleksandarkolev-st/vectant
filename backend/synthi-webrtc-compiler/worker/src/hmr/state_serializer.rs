// ============================================================
// STATE SERIALIZER
// ============================================================
// Provides safe serialization / deserialization of module state
// for snapshot capture and restore.  Wraps serde_json with
// size limits, field-level checksum computation, and
// error-recovery semantics.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Serialization format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SerializationFormat {
    Json,
    JsonCompact,
    MessagePack,
}

/// Serialization constraints.
#[derive(Debug, Clone)]
pub struct SerializerConfig {
    /// Maximum serialized payload size in bytes.
    pub max_payload_bytes: usize,
    /// Maximum JSON depth.
    pub max_depth: usize,
    /// Whether to compute per-field checksums.
    pub compute_field_checksums: bool,
    /// Preferred format.
    pub format: SerializationFormat,
}

impl Default for SerializerConfig {
    fn default() -> Self {
        Self {
            max_payload_bytes: 16 * 1024 * 1024, // 16 MB
            max_depth: 32,
            compute_field_checksums: true,
            format: SerializationFormat::Json,
        }
    }
}

/// Serialization result.
#[derive(Debug, Clone)]
pub struct SerializeResult {
    /// Serialized payload bytes.
    pub bytes: Vec<u8>,
    /// Parsed JSON value (for Json formats).
    pub json_value: Option<serde_json::Value>,
    /// Per-field checksums (top-level keys only).
    pub field_checksums: HashMap<String, u64>,
    /// Total size in bytes.
    pub size_bytes: usize,
}

/// Serialization error.
#[derive(Debug, Clone)]
pub enum SerializeError {
    /// Payload exceeds size limit.
    PayloadTooLarge { actual: usize, limit: usize },
    /// Serialization failed.
    SerializationFailed(String),
    /// Deserialization failed.
    DeserializationFailed(String),
    /// Depth exceeds limit.
    DepthExceeded { limit: usize },
}

impl std::fmt::Display for SerializeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PayloadTooLarge { actual, limit } => {
                write!(f, "payload {} bytes exceeds {} limit", actual, limit)
            }
            Self::SerializationFailed(e) => write!(f, "serialization failed: {}", e),
            Self::DeserializationFailed(e) => write!(f, "deserialization failed: {}", e),
            Self::DepthExceeded { limit } => write!(f, "depth exceeds {} limit", limit),
        }
    }
}

/// Compute a simple hash for a JSON value (FNV-1a style).
fn hash_json_value(val: &serde_json::Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let s = val.to_string();
    s.hash(&mut hasher);
    hasher.finish()
}

/// Check JSON depth.
fn json_depth(val: &serde_json::Value) -> usize {
    match val {
        serde_json::Value::Object(map) => {
            1 + map.values().map(json_depth).max().unwrap_or(0)
        }
        serde_json::Value::Array(arr) => {
            1 + arr.iter().map(json_depth).max().unwrap_or(0)
        }
        _ => 1,
    }
}

/// Serialize a `serde_json::Value` with safety checks.
pub fn serialize_state(
    state: &serde_json::Value,
    config: &SerializerConfig,
) -> Result<SerializeResult, SerializeError> {
    // Check depth
    let depth = json_depth(state);
    if depth > config.max_depth {
        return Err(SerializeError::DepthExceeded {
            limit: config.max_depth,
        });
    }

    // Serialize
    let bytes = serde_json::to_vec(state)
        .map_err(|e| SerializeError::SerializationFailed(e.to_string()))?;

    // Check size
    if bytes.len() > config.max_payload_bytes {
        return Err(SerializeError::PayloadTooLarge {
            actual: bytes.len(),
            limit: config.max_payload_bytes,
        });
    }

    // Compute field checksums if enabled
    let field_checksums = if config.compute_field_checksums {
        if let serde_json::Value::Object(map) = state {
            map.iter()
                .map(|(k, v)| (k.clone(), hash_json_value(v)))
                .collect()
        } else {
            HashMap::new()
        }
    } else {
        HashMap::new()
    };

    Ok(SerializeResult {
        size_bytes: bytes.len(),
        bytes,
        json_value: Some(state.clone()),
        field_checksums,
    })
}

/// Deserialize bytes back to a JSON value.
pub fn deserialize_state(
    bytes: &[u8],
    config: &SerializerConfig,
) -> Result<serde_json::Value, SerializeError> {
    if bytes.len() > config.max_payload_bytes {
        return Err(SerializeError::PayloadTooLarge {
            actual: bytes.len(),
            limit: config.max_payload_bytes,
        });
    }

    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| SerializeError::DeserializationFailed(e.to_string()))?;

    let depth = json_depth(&value);
    if depth > config.max_depth {
        return Err(SerializeError::DepthExceeded {
            limit: config.max_depth,
        });
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let state = serde_json::json!({"counter": 42, "name": "test"});
        let config = SerializerConfig::default();
        let result = serialize_state(&state, &config).unwrap();
        assert!(result.size_bytes > 0);
        assert_eq!(result.field_checksums.len(), 2);

        let restored = deserialize_state(&result.bytes, &config).unwrap();
        assert_eq!(state, restored);
    }

    #[test]
    fn size_limit() {
        let state = serde_json::json!({"data": "x".repeat(100)});
        let config = SerializerConfig {
            max_payload_bytes: 10,
            ..Default::default()
        };
        let err = serialize_state(&state, &config).unwrap_err();
        assert!(matches!(err, SerializeError::PayloadTooLarge { .. }));
    }

    #[test]
    fn depth_limit() {
        // Build deeply nested JSON
        let mut val = serde_json::json!(1);
        for _ in 0..40 {
            val = serde_json::json!({"nested": val});
        }
        let config = SerializerConfig {
            max_depth: 32,
            ..Default::default()
        };
        let err = serialize_state(&val, &config).unwrap_err();
        assert!(matches!(err, SerializeError::DepthExceeded { .. }));
    }
}
