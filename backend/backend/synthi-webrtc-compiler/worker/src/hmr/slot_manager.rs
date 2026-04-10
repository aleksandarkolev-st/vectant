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

/// Metadata about a loaded library in a slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotEntry {
    /// Which slot this entry occupies.
    pub slot: LibSlot,

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
    pub fn register_initial(
        &mut self,
        module: &str,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> &SlotEntry {
        self.generation += 1;
        let entry = SlotEntry {
            slot: LibSlot::Primary,
            lib_path,
            content_hash,
            abi_version,
            symbols,
            generation: self.generation,
            active: true,
        };
        self.slots.insert(module.to_string(), [Some(entry), None]);
        self.active_slot.insert(module.to_string(), LibSlot::Primary);
        self.slots.get(module).unwrap()[0].as_ref().unwrap()
    }

    /// Load a new library into the standby slot (preparation phase).
    pub fn prepare_standby(
        &mut self,
        module: &str,
        lib_path: PathBuf,
        content_hash: String,
        abi_version: String,
        symbols: Vec<String>,
    ) -> Result<&SlotEntry, String> {
        let slots = self
            .slots
            .get_mut(module)
            .ok_or_else(|| format!("module '{}' not registered", module))?;

        let active = self.active_slot.get(module).copied().unwrap_or(LibSlot::Primary);
        let standby_idx = match active {
            LibSlot::Primary => 1,
            LibSlot::Standby => 0,
        };

        self.generation += 1;
        slots[standby_idx] = Some(SlotEntry {
            slot: active.other(),
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

        let active = self.active_slot.get(module).copied().unwrap_or(LibSlot::Primary);
        let active_idx = match active { LibSlot::Primary => 0, LibSlot::Standby => 1 };
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
            let active = self.active_slot.get(module).copied().unwrap_or(LibSlot::Primary);
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
        let idx = match active { LibSlot::Primary => 0, LibSlot::Standby => 1 };
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
        mgr.register_initial("gui", PathBuf::from("/tmp/gui_v1.so"), "h1".into(), "1.0".into(), vec![]);

        mgr.prepare_standby("gui", PathBuf::from("/tmp/gui_v2.so"), "h2".into(), "1.0".into(), vec![])
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
        mgr.register_initial("gui", PathBuf::from("/tmp/gui_v1.so"), "h1".into(), "1.0".into(), vec![]);
        mgr.prepare_standby("gui", PathBuf::from("/tmp/gui_v2.so"), "h2".into(), "1.0".into(), vec![])
            .unwrap();
        mgr.discard_standby("gui");

        // Should still have original active
        let active = mgr.get_active("gui").unwrap();
        assert_eq!(active.content_hash, "h1");
    }

    #[test]
    fn swap_without_standby_fails() {
        let mut mgr = SlotManager::new();
        mgr.register_initial("gui", PathBuf::from("/tmp/gui_v1.so"), "h1".into(), "1.0".into(), vec![]);
        assert!(mgr.swap("gui").is_err());
    }
}
