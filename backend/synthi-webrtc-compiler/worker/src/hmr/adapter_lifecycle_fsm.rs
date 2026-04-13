// ============================================================
// ADAPTER LIFECYCLE FSM
// ============================================================
// Unified finite state machine that drives any adapter through
// its lifecycle: Created → Initializing → Ready → Reloading →
// ShuttingDown → Terminated.  Handles transitions, guards, and
// produces events for the telemetry pipeline.
// ============================================================


use serde::{Deserialize, Serialize};

/// Lifecycle states common to all adapter families.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdapterLifecycleState {
    Created,
    Initializing,
    Ready,
    Reloading,
    Faulted,
    ShuttingDown,
    Terminated,
}

/// Events that drive state transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LifecycleEvent {
    Initialize,
    InitializeComplete,
    InitializeFailed,
    BeginReload,
    ReloadComplete,
    ReloadFailed,
    Recover,
    BeginShutdown,
    ShutdownComplete,
}

/// A recorded transition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub from: AdapterLifecycleState,
    pub to: AdapterLifecycleState,
    pub event: LifecycleEvent,
    pub timestamp_ms: u64,
}

/// Error when an event is not valid in the current state.
#[derive(Debug, Clone)]
pub struct InvalidTransition {
    pub state: AdapterLifecycleState,
    pub event: LifecycleEvent,
}

/// The lifecycle FSM.
pub struct AdapterLifecycleFsm {
    state: AdapterLifecycleState,
    history: Vec<Transition>,
    reload_count: u32,
    fault_count: u32,
}

impl AdapterLifecycleFsm {
    pub fn new() -> Self {
        Self {
            state: AdapterLifecycleState::Created,
            history: Vec::new(),
            reload_count: 0,
            fault_count: 0,
        }
    }

    pub fn state(&self) -> AdapterLifecycleState {
        self.state
    }

    pub fn reload_count(&self) -> u32 {
        self.reload_count
    }

    pub fn fault_count(&self) -> u32 {
        self.fault_count
    }

    pub fn history(&self) -> &[Transition] {
        &self.history
    }

    /// Apply an event and transition to the next state.
    pub fn apply(
        &mut self,
        event: LifecycleEvent,
        now_ms: u64,
    ) -> Result<AdapterLifecycleState, InvalidTransition> {
        let next = self.next_state(event)?;

        self.history.push(Transition {
            from: self.state,
            to: next,
            event,
            timestamp_ms: now_ms,
        });

        // Side effects.
        if next == AdapterLifecycleState::Ready
            && self.state == AdapterLifecycleState::Reloading
        {
            self.reload_count += 1;
        }
        if next == AdapterLifecycleState::Faulted {
            self.fault_count += 1;
        }

        self.state = next;
        Ok(next)
    }

    fn next_state(
        &self,
        event: LifecycleEvent,
    ) -> Result<AdapterLifecycleState, InvalidTransition> {
        use AdapterLifecycleState::*;
        use LifecycleEvent::*;

        let next = match (self.state, event) {
            (Created, Initialize) => Initializing,
            (Initializing, InitializeComplete) => Ready,
            (Initializing, InitializeFailed) => Faulted,
            (Ready, BeginReload) => Reloading,
            (Reloading, ReloadComplete) => Ready,
            (Reloading, ReloadFailed) => Faulted,
            (Faulted, Recover) => Ready,
            (Faulted, BeginShutdown) => ShuttingDown,
            (Ready, BeginShutdown) => ShuttingDown,
            (Reloading, BeginShutdown) => ShuttingDown,
            (ShuttingDown, ShutdownComplete) => Terminated,
            _ => {
                return Err(InvalidTransition {
                    state: self.state,
                    event,
                });
            }
        };

        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_lifecycle() {
        let mut fsm = AdapterLifecycleFsm::new();
        assert_eq!(fsm.state(), AdapterLifecycleState::Created);

        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Initializing);

        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Ready);

        fsm.apply(LifecycleEvent::BeginReload, 300).unwrap();
        fsm.apply(LifecycleEvent::ReloadComplete, 400).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Ready);
        assert_eq!(fsm.reload_count(), 1);

        fsm.apply(LifecycleEvent::BeginShutdown, 500).unwrap();
        fsm.apply(LifecycleEvent::ShutdownComplete, 600).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Terminated);
    }

    #[test]
    fn fault_and_recovery() {
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeFailed, 200).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Faulted);
        assert_eq!(fsm.fault_count(), 1);

        fsm.apply(LifecycleEvent::Recover, 300).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Ready);
    }

    #[test]
    fn invalid_transition_rejected() {
        let mut fsm = AdapterLifecycleFsm::new();
        let result = fsm.apply(LifecycleEvent::BeginReload, 100);
        assert!(result.is_err());
    }

    #[test]
    fn reload_failure_causes_fault() {
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        fsm.apply(LifecycleEvent::BeginReload, 300).unwrap();
        fsm.apply(LifecycleEvent::ReloadFailed, 400).unwrap();
        assert_eq!(fsm.state(), AdapterLifecycleState::Faulted);
    }

    #[test]
    fn history_recorded() {
        let mut fsm = AdapterLifecycleFsm::new();
        fsm.apply(LifecycleEvent::Initialize, 100).unwrap();
        fsm.apply(LifecycleEvent::InitializeComplete, 200).unwrap();
        assert_eq!(fsm.history().len(), 2);
        assert_eq!(fsm.history()[0].from, AdapterLifecycleState::Created);
        assert_eq!(fsm.history()[0].to, AdapterLifecycleState::Initializing);
    }
}
