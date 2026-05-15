// ============================================================
// LIBRARY SLOT MANAGER
// ============================================================
// Manages the two-slot (primary + standby) library loading
// scheme for dynamic library hot-swap. The new library is
// loaded into the standby slot while the primary keeps running,
// then slots are atomically swapped.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// A library slot identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LibSlot {
    Primary,
    Standby,
}

impl LibSlot {
    pub fn other(&self) -> Self {
        match self {
            LibSlot::Primary => LibSlot::Standby,
            LibSlot::Standby => LibSlot::Primary,
        }
    }
}

/// What kind of artifact a slot is carrying.
///
/// Added for GPU-HMR Phase 1 (docs/GPU_HMR_ULTRAPLAN.md §5.3): the
/// two-slot scheme is reused for device modules (cubin/hsaco), but
/// the planner needs to tell host `.so` slots from device modules
/// when deciding which adapter to drive on swap. `Host` is the
/// default — both for new entries that omit the field (serde
/// `default`) and for the existing API that doesn't take a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    /// Host CPU shared library (.so on Linux, .dylib on macOS).
    /// Driven by `DynLibAdapter` via `dlopen` / `dlclose`.
    #[default]
    Host,
    /// GPU device module — cubin (NVIDIA) or hsaco (AMD). Driven
    /// by `GpuModuleAdapter` via `cuModuleLoadData` /
    /// `hipModuleLoadData`. Only meaningful with the `gpu-hmr`
    /// cargo feature on.
    Device,
}

impl SlotKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Device => "device",
        }
    }

    pub fn is_device(&self) -> bool {
        matches!(self, Self::Device)
    }
}

/// Metadata about a loaded library in a slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotEntry {
    /// Which slot this entry occupies.
    pub slot: LibSlot,

    /// Whether this entry is a host `.so` or a device cubin/hsaco.
    /// Defaults to `Host` when missing from serialized state so
    /// pre-GPU-HMR snapshots still deserialize.
    #[serde(default)]
    pub kind: SlotKind,

    /// Path to the shared library file.
    pub lib_path: PathBuf,

    /// Content hash of the library file.
    pub content_hash: String,

    /// ABI version string.
    pub abi_version: String,

    /// Verified exported symbols.
    pub symbols: Vec<String>,

    /// Generation counter (incremented on each swap).
    pub generation: u64,

    /// Whether this slot is the active one (serving frames).
    pub active: bool,
}

impl SlotEntry {
    pub fn is_device(&self) -> bool {
        self.kind.is_device()
    }
}

/// Manages two-slot library loading.
pub struct SlotManager {
    /// Module name → slot entries.
    slots: HashMap<String, [Option<SlotEntry>; 2]>,

    /// Which slot is currently active per module.
    active_slot: HashMap<String, LibSlot>,

    /// Global generation counter.
    generation: u64,
}

impl SlotManager {
    pub fn new() -> Self {
        Self {
            slots: HashMap::new(),
            active_slot: HashMap::new(),
            generation: 0,
        }
    }

    /// Register a module's initial library load into the primary slot.
    /// Backwards-compatible wrapper that defaults `kind = SlotKind::Host`.
    pub fn register_initial(
        &mut self,
        module: &str,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> &SlotEntry {
        self.register_initial_with_kind(
            module,
            SlotKind::Host,
            lib_path,
            content_hash,
            abi_version,
            symbols,
        )
    }

    /// Register a module's initial load with an explicit `kind`.
    /// Use this from the GPU module adapter (kind=Device); the
    /// host dynlib path keeps using the backwards-compatible
    /// `register_initial` above (kind=Host).
    pub fn register_initial_with_kind(
        &mut self,
        module: &str,
        kind: SlotKind,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> &SlotEntry {
        self.generation += 1;
        let entry = SlotEntry {
            slot: LibSlot::Primary,
            kind,
            lib_path,
            content_hash,
            abi_version,
            symbols,
            generation: self.generation,
            active: true,
        };
        self.slots.insert(module.to_string(), [Some(entry), None]);
        self.active_slot
            .insert(module.to_string(), LibSlot::Primary);
        self.slots.get(module).unwrap()[0].as_ref().unwrap()
    }

    /// Load a new library into the standby slot (preparation phase).
    /// Backwards-compatible wrapper that defaults `kind = SlotKind::Host`.
    pub fn prepare_standby(
        &mut self,
        module: &str,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> Result<&SlotEntry, String> {
        self.prepare_standby_with_kind(
            module,
            SlotKind::Host,
            lib_path,
            content_hash,
            abi_version,
            symbols,
        )
    }

    /// Load a new artifact into the standby slot with an explicit
    /// `kind`. Caller's responsibility to ensure the kind matches
    /// the primary slot's kind — mixing host and device in the
    /// same module name is rejected.
    pub fn prepare_standby_with_kind(
        &mut self,
        module: &str,
        kind: SlotKind,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> Result<&SlotEntry, String> {
        let slots = self
            .slots
            .get_mut(module)
            .ok_or_else(|| format!("module '{}' not registered", module))?;

        // Cross-kind swap is a planner bug — fail fast rather than
        // silently swap a cubin for a `.so`.
        let active_idx_for_kind = match self
            .active_slot
            .get(module)
            .copied()
            .unwrap_or(LibSlot::Primary)
        {
            LibSlot::Primary => 0,
            LibSlot::Standby => 1,
        };
        if let Some(active) = &slots[active_idx_for_kind] {
            if active.kind != kind {
                return Err(format!(
                    "kind mismatch for module '{}': active={:?}, standby={:?}",
                    module, active.kind, kind
                ));
            }
        }

        let active = self
            .active_slot
            .get(module)
            .copied()
            .unwrap_or(LibSlot::Primary);
        let standby_idx = match active {
            LibSlot::Primary => 1,
            LibSlot::Standby => 0,
        };

        self.generation += 1;
        slots[standby_idx] = Some(SlotEntry {
            slot: active.other(),
            kind,
            lib_path,
            content_hash,
            abi_version,
            symbols,
            generation: self.generation,
            active: false,
        });

        Ok(slots[standby_idx].as_ref().unwrap())
    }

    /// Atomically swap active ↔ standby for a module.
    pub fn swap(&mut self, module: &str) -> Result<SwapResult, String> {
        let slots = self
            .slots
            .get_mut(module)
            .ok_or_else(|| format!("module '{}' not registered", module))?;

        let active = self
            .active_slot
            .get(module)
            .copied()
            .unwrap_or(LibSlot::Primary);
        let active_idx = match active {
            LibSlot::Primary => 0,
            LibSlot::Standby => 1,
        };
        let standby_idx = 1 - active_idx;

        if slots[standby_idx].is_none() {
            return Err(format!("no standby library prepared for '{}'", module));
        }

        // Mark old active as inactive
        if let Some(entry) = &mut slots[active_idx] {
            entry.active = false;
        }
        // Mark new active
        if let Some(entry) = &mut slots[standby_idx] {
            entry.active = true;
        }

        let new_active = active.other();
        self.active_slot.insert(module.to_string(), new_active);

        Ok(SwapResult {
            module: module.to_string(),
            old_slot: active,
            new_slot: new_active,
            generation: slots[standby_idx].as_ref().unwrap().generation,
        })
    }

    /// Rollback: discard the standby slot (e.g., after failed health check).
    pub fn discard_standby(&mut self, module: &str) {
        if let Some(slots) = self.slots.get_mut(module) {
            let active = self
                .active_slot
                .get(module)
                .copied()
                .unwrap_or(LibSlot::Primary);
            let standby_idx = match active {
                LibSlot::Primary => 1,
                LibSlot::Standby => 0,
            };
            slots[standby_idx] = None;
        }
    }

    /// Get the active slot entry for a module.
    pub fn get_active(&self, module: &str) -> Option<&SlotEntry> {
        let slots = self.slots.get(module)?;
        let active = self.active_slot.get(module)?;
        let idx = match active {
            LibSlot::Primary => 0,
            LibSlot::Standby => 1,
        };
        slots[idx].as_ref()
    }

    /// Get the current generation counter.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

/// Result of a slot swap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapResult {
    pub module: String,
    pub old_slot: LibSlot,
    pub new_slot: LibSlot,
    pub generation: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_register() {
        let mut mgr = SlotManager::new();
        let entry = mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/gui_v1.so"),
            "h1".into(),
            "1.0".into(),
            vec!["on_render".into()],
        );
        assert_eq!(entry.slot, LibSlot::Primary);
        assert!(entry.active);
        assert_eq!(mgr.generation(), 1);
    }

    #[test]
    fn prepare_and_swap() {
        let mut mgr = SlotManager::new();
        mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/gui_v1.so"),
            "h1".into(),
            "1.0".into(),
            vec![],
        );

        mgr.prepare_standby(
            "gui",
            PathBuf::from("/tmp/gui_v2.so"),
            "h2".into(),
            "1.0".into(),
            vec![],
        )
        .unwrap();

        let result = mgr.swap("gui").unwrap();
        assert_eq!(result.old_slot, LibSlot::Primary);
        assert_eq!(result.new_slot, LibSlot::Standby);

        let active = mgr.get_active("gui").unwrap();
        assert!(active.active);
        assert_eq!(active.content_hash, "h2");
    }

    #[test]
    fn discard_standby() {
        let mut mgr = SlotManager::new();
        mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/gui_v1.so"),
            "h1".into(),
            "1.0".into(),
            vec![],
        );
        mgr.prepare_standby(
            "gui",
            PathBuf::from("/tmp/gui_v2.so"),
            "h2".into(),
            "1.0".into(),
            vec![],
        )
        .unwrap();
        mgr.discard_standby("gui");

        // Should still have original active
        let active = mgr.get_active("gui").unwrap();
        assert_eq!(active.content_hash, "h1");
    }

    #[test]
    fn swap_without_standby_fails() {
        let mut mgr = SlotManager::new();
        mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/gui_v1.so"),
            "h1".into(),
            "1.0".into(),
            vec![],
        );
        assert!(mgr.swap("gui").is_err());
    }

    // ── SlotKind extensions (GPU-HMR Phase 1) ─────────────

    #[test]
    fn default_kind_is_host() {
        assert_eq!(SlotKind::default(), SlotKind::Host);
        assert_eq!(SlotKind::Host.as_str(), "host");
        assert_eq!(SlotKind::Device.as_str(), "device");
        assert!(!SlotKind::Host.is_device());
        assert!(SlotKind::Device.is_device());
    }

    #[test]
    fn register_initial_defaults_to_host_kind() {
        let mut mgr = SlotManager::new();
        let entry = mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/g.so"),
            "h".into(),
            "1".into(),
            vec![],
        );
        assert_eq!(entry.kind, SlotKind::Host);
        assert!(!entry.is_device());
    }

    #[test]
    fn register_initial_with_device_kind() {
        let mut mgr = SlotManager::new();
        let entry = mgr.register_initial_with_kind(
            "device",
            SlotKind::Device,
            PathBuf::from("/tmp/device.cubin"),
            "cu1".into(),
            "sm_120".into(),
            vec!["vec_add".into()],
        );
        assert_eq!(entry.kind, SlotKind::Device);
        assert!(entry.is_device());
        assert!(entry.active);
        assert_eq!(entry.symbols, vec!["vec_add".to_string()]);
    }

    #[test]
    fn prepare_standby_inherits_kind_correctly() {
        let mut mgr = SlotManager::new();
        mgr.register_initial_with_kind(
            "device",
            SlotKind::Device,
            PathBuf::from("/tmp/device_v1.cubin"),
            "cu1".into(),
            "sm_120".into(),
            vec![],
        );
        let standby = mgr
            .prepare_standby_with_kind(
                "device",
                SlotKind::Device,
                PathBuf::from("/tmp/device_v2.cubin"),
                "cu2".into(),
                "sm_120".into(),
                vec![],
            )
            .unwrap();
        assert_eq!(standby.kind, SlotKind::Device);
    }

    #[test]
    fn prepare_standby_rejects_kind_mismatch() {
        let mut mgr = SlotManager::new();
        mgr.register_initial(
            "gui",
            PathBuf::from("/tmp/g.so"),
            "h".into(),
            "1".into(),
            vec![],
        );
        // Active is Host; preparing a Device standby is a planner bug.
        let err = mgr
            .prepare_standby_with_kind(
                "gui",
                SlotKind::Device,
                PathBuf::from("/tmp/g.cubin"),
                "cu".into(),
                "1".into(),
                vec![],
            )
            .unwrap_err();
        assert!(err.contains("kind mismatch"), "got: {err}");
    }

    #[test]
    fn slot_entry_deserializes_without_kind_field() {
        // Pre-GPU-HMR serialized state didn't have a `kind` field —
        // serde(default) must fill it in as Host. Crucial for
        // upgrades on running deployments that already have slot
        // state on disk.
        let legacy_json = r#"{
            "slot": "Primary",
            "lib_path": "/tmp/legacy.so",
            "content_hash": "h",
            "abi_version": "1",
            "symbols": [],
            "generation": 1,
            "active": true
        }"#;
        let entry: SlotEntry = serde_json::from_str(legacy_json).expect("legacy SlotEntry parses");
        assert_eq!(entry.kind, SlotKind::Host);
        assert!(!entry.is_device());
    }

    #[test]
    fn slot_entry_serializes_with_kind_field() {
        let entry = SlotEntry {
            slot: LibSlot::Primary,
            kind: SlotKind::Device,
            lib_path: PathBuf::from("/tmp/device.cubin"),
            content_hash: "cu".into(),
            abi_version: "sm_120".into(),
            symbols: vec![],
            generation: 1,
            active: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"kind\":\"device\""));
        let back: SlotEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, SlotKind::Device);
    }
}
