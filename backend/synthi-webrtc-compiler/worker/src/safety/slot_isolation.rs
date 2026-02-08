// ============================================================
// SLOT ISOLATION MODEL - PER-MODULE WORKER ISOLATION
// ============================================================
// Addresses requirement #7: Better slot model for true HMR isolation
//
// PROBLEM:
// - Current "worker contains core/gui/audio" means any module reload
//   kills the whole worker, losing isolation benefits
// - If we claim "modules run in disposable child processes", we must
//   align that with actual restart granularity
//
// SOLUTIONS:
//
// OPTION A: Single Worker (simpler, current)
// - One worker process holds all modules
// - Any module reload restarts entire worker
// - State transfer via snapshot for ALL modules
// - Pro: Simple, low overhead
// - Con: No isolation between modules
//
// OPTION B: Worker Per Slot (true isolation)
// - Separate worker process per module slot
// - Reloading GUI doesn't kill audio worker
// - Each worker has its own snapshot/state
// - Pro: True isolation, targeted restarts
// - Con: More processes, IPC between workers
//
// This module supports both models with explicit configuration.
// ============================================================

// #![allow(dead_code)] - REMOVED: This module is now wired up in main.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

// ============================================================
// ISOLATION MODELS
// ============================================================

/// Isolation model for hot module reloading
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IsolationModel {
    /// Single worker holds all modules (simpler)
    /// - Module reload restarts entire worker
    /// - Acceptable for small number of modules
    /// - Lower resource overhead
    SingleWorker,

    /// One worker per module slot (true isolation)
    /// - Module reload only affects that slot's worker
    /// - Other modules continue running
    /// - Higher resource overhead
    WorkerPerSlot,

    /// Grouped workers (compromise)
    /// - Critical modules in isolated workers
    /// - Less critical modules share a worker
    /// - Configurable grouping
    GroupedWorkers,
}

impl Default for IsolationModel {
    fn default() -> Self {
        IsolationModel::SingleWorker
    }
}

// ============================================================
// SLOT CONFIGURATION
// ============================================================

/// Configuration for a module slot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotConfig {
    /// Slot identifier
    pub slot_id: String,
    /// Human-readable name
    pub name: String,
    /// Module type (for grouping)
    pub module_type: ModuleType,
    /// Isolation group (for GroupedWorkers model)
    pub isolation_group: Option<String>,
    /// Maximum snapshot size for this slot
    pub max_snapshot_size: usize,
    /// Quiescence timeout for this slot
    pub quiescence_timeout: Duration,
    /// Whether this slot is critical (affects restart behavior)
    pub is_critical: bool,
    /// Dependencies on other slots (load order)
    pub depends_on: Vec<String>,
}

impl Default for SlotConfig {
    fn default() -> Self {
        Self {
            slot_id: "default".to_string(),
            name: "Default Slot".to_string(),
            module_type: ModuleType::Logic,
            isolation_group: None,
            max_snapshot_size: 8 * 1024 * 1024, // 8 MB
            quiescence_timeout: Duration::from_secs(5),
            is_critical: false,
            depends_on: Vec::new(),
        }
    }
}

/// Module type categories
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModuleType {
    /// Core logic (state, game logic)
    Logic,
    /// GUI/rendering
    Gui,
    /// Audio processing
    Audio,
    /// Network/IO
    Network,
    /// Custom/plugin
    Plugin,
}

impl ModuleType {
    /// Get recommended isolation group for this type
    pub fn recommended_group(&self) -> &'static str {
        match self {
            ModuleType::Logic => "main",
            ModuleType::Gui => "main",
            ModuleType::Audio => "audio", // Audio often needs isolation
            ModuleType::Network => "io",
            ModuleType::Plugin => "plugins",
        }
    }
}

// ============================================================
// WORKER STATE
// ============================================================

/// State of a worker in the isolation model
#[derive(Debug, Clone)]
pub struct WorkerState {
    /// Worker ID
    pub worker_id: WorkerId,
    /// Process ID (if running)
    pub pid: Option<u32>,
    /// Slots managed by this worker
    pub slots: Vec<String>,
    /// When this worker was started
    pub started_at: Option<Instant>,
    /// Last heartbeat received
    pub last_heartbeat: Option<Instant>,
    /// Current state
    pub state: WorkerLifecycleState,
    /// Restart count
    pub restart_count: u32,
}

/// Unique worker identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkerId(pub u64);

impl WorkerId {
    pub fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        WorkerId(COUNTER.fetch_add(1, Ordering::SeqCst))
    }
}

impl Default for WorkerId {
    fn default() -> Self {
        Self::new()
    }
}

/// Worker lifecycle state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerLifecycleState {
    /// Not started
    NotStarted,
    /// Starting up
    Starting,
    /// Running normally
    Running,
    /// In quiescence (preparing for reload)
    Quiescing,
    /// Snapshot being taken
    Snapshotting,
    /// Being killed for reload
    Dying,
    /// Dead, pending restart
    Dead,
    /// Restarting
    Restarting,
    /// Failed, needs intervention
    Failed,
}

// ============================================================
// ISOLATION MANAGER
// ============================================================

/// Manages worker isolation based on configured model
pub struct IsolationManager {
    /// Configured isolation model
    model: IsolationModel,
    /// Slot configurations
    slots: HashMap<String, SlotConfig>,
    /// Worker states
    workers: HashMap<WorkerId, WorkerState>,
    /// Slot to worker mapping
    slot_to_worker: HashMap<String, WorkerId>,
    /// Group to worker mapping (for GroupedWorkers)
    _group_to_worker: HashMap<String, WorkerId>,
}

impl IsolationManager {
    pub fn new(model: IsolationModel) -> Self {
        Self {
            model,
            slots: HashMap::new(),
            workers: HashMap::new(),
            slot_to_worker: HashMap::new(),
            _group_to_worker: HashMap::new(),
        }
    }

    /// Register a slot
    pub fn register_slot(&mut self, config: SlotConfig) {
        self.slots.insert(config.slot_id.clone(), config);
    }

    /// Plan worker allocation based on model and registered slots
    pub fn plan_allocation(&mut self) -> WorkerAllocationPlan {
        match self.model {
            IsolationModel::SingleWorker => self.plan_single_worker(),
            IsolationModel::WorkerPerSlot => self.plan_worker_per_slot(),
            IsolationModel::GroupedWorkers => self.plan_grouped_workers(),
        }
    }

    fn plan_single_worker(&self) -> WorkerAllocationPlan {
        let worker_id = WorkerId::new();
        let slots: Vec<String> = self.slots.keys().cloned().collect();

        WorkerAllocationPlan {
            workers: vec![WorkerPlan {
                worker_id,
                slots: slots.clone(),
                group: Some("all".to_string()),
            }],
            slot_to_worker: slots.into_iter().map(|s| (s, worker_id)).collect(),
        }
    }

    fn plan_worker_per_slot(&self) -> WorkerAllocationPlan {
        let mut workers = Vec::new();
        let mut slot_to_worker = HashMap::new();

        for slot_id in self.slots.keys() {
            let worker_id = WorkerId::new();
            workers.push(WorkerPlan {
                worker_id,
                slots: vec![slot_id.clone()],
                group: None,
            });
            slot_to_worker.insert(slot_id.clone(), worker_id);
        }

        WorkerAllocationPlan {
            workers,
            slot_to_worker,
        }
    }

    fn plan_grouped_workers(&self) -> WorkerAllocationPlan {
        let mut group_slots: HashMap<String, Vec<String>> = HashMap::new();

        // Group slots by isolation group
        for (slot_id, config) in &self.slots {
            let group = config
                .isolation_group
                .clone()
                .unwrap_or_else(|| config.module_type.recommended_group().to_string());

            group_slots.entry(group).or_default().push(slot_id.clone());
        }

        let mut workers = Vec::new();
        let mut slot_to_worker = HashMap::new();

        for (group, slots) in group_slots {
            let worker_id = WorkerId::new();
            workers.push(WorkerPlan {
                worker_id,
                slots: slots.clone(),
                group: Some(group),
            });

            for slot in slots {
                slot_to_worker.insert(slot, worker_id);
            }
        }

        WorkerAllocationPlan {
            workers,
            slot_to_worker,
        }
    }

    /// Get the worker for a given slot
    pub fn get_worker_for_slot(&self, slot_id: &str) -> Option<WorkerId> {
        self.slot_to_worker.get(slot_id).copied()
    }

    /// Get all slots for a worker
    pub fn get_slots_for_worker(&self, worker_id: WorkerId) -> Vec<String> {
        self.workers
            .get(&worker_id)
            .map(|w| w.slots.clone())
            .unwrap_or_default()
    }

    /// Determine restart scope for a slot reload
    pub fn get_restart_scope(&self, slot_id: &str) -> RestartScope {
        match self.model {
            IsolationModel::SingleWorker => {
                // All slots restart
                RestartScope::AllSlots {
                    slots: self.slots.keys().cloned().collect(),
                }
            }
            IsolationModel::WorkerPerSlot => {
                // Only this slot restarts
                RestartScope::SingleSlot {
                    slot: slot_id.to_string(),
                }
            }
            IsolationModel::GroupedWorkers => {
                // All slots in the same group restart
                if let Some(worker_id) = self.slot_to_worker.get(slot_id) {
                    if let Some(worker) = self.workers.get(worker_id) {
                        return RestartScope::SlotGroup {
                            slots: worker.slots.clone(),
                            group: self.get_group_for_slot(slot_id),
                        };
                    }
                }
                RestartScope::SingleSlot {
                    slot: slot_id.to_string(),
                }
            }
        }
    }

    fn get_group_for_slot(&self, slot_id: &str) -> Option<String> {
        self.slots
            .get(slot_id)
            .and_then(|c| c.isolation_group.clone())
    }
}

/// Plan for worker allocation
#[derive(Debug, Clone)]
pub struct WorkerAllocationPlan {
    pub workers: Vec<WorkerPlan>,
    pub slot_to_worker: HashMap<String, WorkerId>,
}

/// Plan for a single worker
#[derive(Debug, Clone)]
pub struct WorkerPlan {
    pub worker_id: WorkerId,
    pub slots: Vec<String>,
    pub group: Option<String>,
}

/// Scope of restart when reloading a slot
#[derive(Debug, Clone)]
pub enum RestartScope {
    /// Only the specified slot restarts
    SingleSlot { slot: String },
    /// A group of slots restart together
    SlotGroup {
        slots: Vec<String>,
        group: Option<String>,
    },
    /// All slots restart
    AllSlots { slots: Vec<String> },
}

impl RestartScope {
    /// Get affected slot count
    pub fn affected_count(&self) -> usize {
        match self {
            RestartScope::SingleSlot { .. } => 1,
            RestartScope::SlotGroup { slots, .. } => slots.len(),
            RestartScope::AllSlots { slots } => slots.len(),
        }
    }

    /// Check if a slot is affected
    pub fn affects_slot(&self, slot_id: &str) -> bool {
        match self {
            RestartScope::SingleSlot { slot } => slot == slot_id,
            RestartScope::SlotGroup { slots, .. } => slots.contains(&slot_id.to_string()),
            RestartScope::AllSlots { slots } => slots.contains(&slot_id.to_string()),
        }
    }
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_worker_model() {
        let mut manager = IsolationManager::new(IsolationModel::SingleWorker);

        manager.register_slot(SlotConfig {
            slot_id: "core".to_string(),
            ..Default::default()
        });
        manager.register_slot(SlotConfig {
            slot_id: "gui".to_string(),
            ..Default::default()
        });

        let plan = manager.plan_allocation();

        // Should have exactly one worker
        assert_eq!(plan.workers.len(), 1);
        // Worker should have both slots
        assert_eq!(plan.workers[0].slots.len(), 2);
    }

    #[test]
    fn test_worker_per_slot_model() {
        let mut manager = IsolationManager::new(IsolationModel::WorkerPerSlot);

        manager.register_slot(SlotConfig {
            slot_id: "core".to_string(),
            ..Default::default()
        });
        manager.register_slot(SlotConfig {
            slot_id: "gui".to_string(),
            ..Default::default()
        });

        let plan = manager.plan_allocation();

        // Should have two workers
        assert_eq!(plan.workers.len(), 2);
        // Each worker should have one slot
        for worker in &plan.workers {
            assert_eq!(worker.slots.len(), 1);
        }
    }

    #[test]
    fn test_grouped_workers_model() {
        let mut manager = IsolationManager::new(IsolationModel::GroupedWorkers);

        manager.register_slot(SlotConfig {
            slot_id: "core".to_string(),
            isolation_group: Some("main".to_string()),
            ..Default::default()
        });
        manager.register_slot(SlotConfig {
            slot_id: "gui".to_string(),
            isolation_group: Some("main".to_string()),
            ..Default::default()
        });
        manager.register_slot(SlotConfig {
            slot_id: "audio".to_string(),
            isolation_group: Some("audio".to_string()),
            ..Default::default()
        });

        let plan = manager.plan_allocation();

        // Should have two workers (main group, audio group)
        assert_eq!(plan.workers.len(), 2);
    }

    #[test]
    fn test_restart_scope() {
        let scope = RestartScope::SlotGroup {
            slots: vec!["a".to_string(), "b".to_string()],
            group: Some("test".to_string()),
        };

        assert_eq!(scope.affected_count(), 2);
        assert!(scope.affects_slot("a"));
        assert!(scope.affects_slot("b"));
        assert!(!scope.affects_slot("c"));
    }
}
