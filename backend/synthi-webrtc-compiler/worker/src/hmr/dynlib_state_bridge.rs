// ============================================================
// DYNLIB STATE BRIDGE
// ============================================================
// Bridges the state serialization/deserialization between the
// HMR state management layer and the loaded dynlib's ABI
// functions (hmr_get_state_json/hmr_set_state_json and binary
// variants).
// ============================================================

use serde::{Deserialize, Serialize};

/// Format for state transfer through the dynlib ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StateFormat {
    /// JSON via hmr_get_state_json / hmr_set_state_json.
    Json,
    /// Binary (MessagePack) via hmr_get_state_binary / hmr_set_state_binary.
    Binary,
}

/// Describes the state capabilities of a loaded library.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateCapabilities {
    /// Whether JSON state functions are available.
    pub json: bool,
    /// Whether binary state functions are available.
    pub binary: bool,
}

impl StateCapabilities {
    /// Best format to use, preferring binary for performance.
    pub fn preferred_format(&self) -> Option<StateFormat> {
        if self.binary {
            Some(StateFormat::Binary)
        } else if self.json {
            Some(StateFormat::Json)
        } else {
            None
        }
    }

    /// Whether any state transfer is supported.
    pub fn any(&self) -> bool {
        self.json || self.binary
    }
}

/// Configuration for the state bridge.
#[derive(Debug, Clone)]
pub struct StateBridgeConfig {
    /// Maximum state payload size (bytes).
    pub max_state_bytes: usize,
    /// Preferred format (None = auto-detect from capabilities).
    pub preferred_format: Option<StateFormat>,
    /// Whether to validate state after restore.
    pub validate_after_restore: bool,
}

impl Default for StateBridgeConfig {
    fn default() -> Self {
        Self {
            max_state_bytes: 16 * 1024 * 1024, // 16 MB
            preferred_format: None,
            validate_after_restore: true,
        }
    }
}

/// Result of a state export operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateExport {
    pub format: StateFormat,
    pub data: Vec<u8>,
    pub size_bytes: usize,
    pub export_ms: u64,
}

/// Result of a state import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateImport {
    pub format: StateFormat,
    pub size_bytes: usize,
    pub import_ms: u64,
    pub validated: bool,
}

/// The state bridge manages export/import through the ABI.
pub struct DynLibStateBridge {
    config: StateBridgeConfig,
    capabilities: StateCapabilities,
    active_format: Option<StateFormat>,
}

impl DynLibStateBridge {
    pub fn new(config: StateBridgeConfig, capabilities: StateCapabilities) -> Self {
        let active_format = config
            .preferred_format
            .or_else(|| capabilities.preferred_format());
        Self {
            config,
            capabilities,
            active_format,
        }
    }

    /// Whether state transfer is available.
    pub fn is_available(&self) -> bool {
        self.active_format.is_some()
    }

    /// Current format being used.
    pub fn format(&self) -> Option<StateFormat> {
        self.active_format
    }

    /// Export state from the loaded library.
    ///
    /// In production, calls hmr_get_state_json or hmr_get_state_binary
    /// through the resolved function pointer.
    pub fn export_state(&self, simulated_data: &[u8]) -> Result<StateExport, String> {
        let format = self.active_format.ok_or("no state format available")?;

        if simulated_data.len() > self.config.max_state_bytes {
            return Err(format!(
                "state size {} exceeds limit {}",
                simulated_data.len(),
                self.config.max_state_bytes
            ));
        }

        Ok(StateExport {
            format,
            data: simulated_data.to_vec(),
            size_bytes: simulated_data.len(),
            export_ms: 5, // simulated
        })
    }

    /// Import state into the loaded library.
    pub fn import_state(&self, export: &StateExport) -> Result<StateImport, String> {
        let format = self.active_format.ok_or("no state format available")?;

        if export.format != format {
            return Err(format!(
                "format mismatch: export is {:?}, bridge uses {:?}",
                export.format, format
            ));
        }

        if export.data.len() > self.config.max_state_bytes {
            return Err("state too large for import".into());
        }

        Ok(StateImport {
            format,
            size_bytes: export.data.len(),
            import_ms: 3, // simulated
            validated: self.config.validate_after_restore,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_binary() {
        let caps = StateCapabilities {
            json: true,
            binary: true,
        };
        assert_eq!(caps.preferred_format(), Some(StateFormat::Binary));
    }

    #[test]
    fn falls_back_to_json() {
        let caps = StateCapabilities {
            json: true,
            binary: false,
        };
        assert_eq!(caps.preferred_format(), Some(StateFormat::Json));
    }

    #[test]
    fn no_state_support() {
        let caps = StateCapabilities {
            json: false,
            binary: false,
        };
        assert!(!caps.any());
        let bridge = DynLibStateBridge::new(StateBridgeConfig::default(), caps);
        assert!(!bridge.is_available());
    }

    #[test]
    fn export_import_roundtrip() {
        let caps = StateCapabilities {
            json: true,
            binary: false,
        };
        let bridge = DynLibStateBridge::new(StateBridgeConfig::default(), caps);

        let export = bridge.export_state(b"test state data").unwrap();
        assert_eq!(export.format, StateFormat::Json);
        assert_eq!(export.size_bytes, 15);

        let import = bridge.import_state(&export).unwrap();
        assert_eq!(import.format, StateFormat::Json);
        assert!(import.validated);
    }

    #[test]
    fn rejects_oversized_state() {
        let caps = StateCapabilities {
            json: true,
            binary: false,
        };
        let config = StateBridgeConfig {
            max_state_bytes: 10,
            ..Default::default()
        };
        let bridge = DynLibStateBridge::new(config, caps);

        let result = bridge.export_state(b"this is too long for the limit");
        assert!(result.is_err());
    }
}
