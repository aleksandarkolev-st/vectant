// ============================================================
// PREVIEW LIFECYCLE SCHEMA
// ============================================================
// Defines the canonical lifecycle states for compiled previews.
// Every compiled-language path must emit these states.
// The frontend consumes this same schema for UI feedback.
// ============================================================

use serde::{Deserialize, Serialize};

/// Canonical preview lifecycle states.
///
/// Every compiled-language route must transition through these states.
/// The UI maps directly onto these values—no ad-hoc string matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewLifecycleState {
    /// No active preview session.
    Idle,
    /// A save was detected and a compile request has been queued.
    CompileRequested,
    /// The build plane is actively compiling dirty units.
    Compiling,
    /// Compilation finished successfully; a candidate artifact is ready.
    CompileFinished,
    /// Compilation failed; diagnostics are available.
    CompileFailed,
    /// The runtime planner has decided on a reload strategy.
    ReloadPlanned,
    /// The runtime is actively applying the candidate (warm, cold, managed, or process swap).
    ReloadApplying,
    /// The candidate was promoted successfully and is now the live preview.
    ReloadApplied,
    /// The candidate failed health checks; the old preview was preserved.
    ReloadRolledBack,
    /// The runtime crashed but recovered using the last known-good candidate.
    CrashRecovered,
    /// The runtime crashed fatally and cannot recover without a full restart.
    CrashFatal,
    /// A full restart was performed (last resort).
    FullRestart,
}

impl PreviewLifecycleState {
    /// Returns `true` if the preview is in a state where the user can interact with it.
    pub fn is_preview_alive(&self) -> bool {
        matches!(
            self,
            Self::Idle
                | Self::CompileRequested
                | Self::Compiling
                | Self::CompileFinished
                | Self::CompileFailed
                | Self::ReloadPlanned
                | Self::ReloadApplying
                | Self::ReloadApplied
                | Self::ReloadRolledBack
                | Self::CrashRecovered
        )
    }

    /// Returns `true` if the system is actively building or reloading.
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            Self::CompileRequested | Self::Compiling | Self::ReloadPlanned | Self::ReloadApplying
        )
    }

    /// Returns `true` if the last operation resulted in an error or failure.
    pub fn is_error(&self) -> bool {
        matches!(
            self,
            Self::CompileFailed | Self::ReloadRolledBack | Self::CrashRecovered | Self::CrashFatal
        )
    }
}

/// A lifecycle event emitted by the worker or runtime.
///
/// Carries the new state plus structured metadata so the frontend
/// can render feedback without parsing raw strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewLifecycleEvent {
    /// The new lifecycle state.
    pub state: PreviewLifecycleState,

    /// Unique identifier for the current preview session.
    pub preview_id: String,

    /// Human-readable summary of what happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    /// Structured reason code (e.g. "abi_incompatible", "schema_changed").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,

    /// Milliseconds since the triggering save, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,

    /// Opaque adapter family tag (e.g. "dynamic_library", "managed_runtime").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_family: Option<String>,

    /// Wall-clock timestamp (epoch millis).
    pub timestamp_ms: u64,
}

impl PreviewLifecycleEvent {
    pub fn new(state: PreviewLifecycleState, preview_id: impl Into<String>) -> Self {
        Self {
            state,
            preview_id: preview_id.into(),
            message: None,
            reason_code: None,
            elapsed_ms: None,
            adapter_family: None,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }

    pub fn with_message(mut self, msg: impl Into<String>) -> Self {
        self.message = Some(msg.into());
        self
    }

    pub fn with_reason(mut self, code: impl Into<String>) -> Self {
        self.reason_code = Some(code.into());
        self
    }

    pub fn with_elapsed(mut self, ms: u64) -> Self {
        self.elapsed_ms = Some(ms);
        self
    }

    pub fn with_adapter_family(mut self, family: impl Into<String>) -> Self {
        self.adapter_family = Some(family.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_state_predicates() {
        assert!(PreviewLifecycleState::ReloadApplied.is_preview_alive());
        assert!(!PreviewLifecycleState::CrashFatal.is_preview_alive());
        assert!(PreviewLifecycleState::Compiling.is_busy());
        assert!(!PreviewLifecycleState::Idle.is_busy());
        assert!(PreviewLifecycleState::CompileFailed.is_error());
        assert!(!PreviewLifecycleState::ReloadApplied.is_error());
    }

    #[test]
    fn lifecycle_event_serialization() {
        let event = PreviewLifecycleEvent::new(
            PreviewLifecycleState::ReloadApplied,
            "preview-123",
        )
        .with_message("GUI module warm-reloaded")
        .with_elapsed(420);

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("reload_applied"));
        assert!(json.contains("preview-123"));
        assert!(json.contains("420"));

        let deserialized: PreviewLifecycleEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.state, PreviewLifecycleState::ReloadApplied);
    }
}
