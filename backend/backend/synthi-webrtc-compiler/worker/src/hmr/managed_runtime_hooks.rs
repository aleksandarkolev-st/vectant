// ============================================================
// MANAGED RUNTIME LIFECYCLE HOOKS
// ============================================================
// Pre-reload and post-reload hooks specific to managed runtimes.
// Handles class-loader isolation, startup sequence detection,
// and host-agent communication protocol.
// ============================================================


use serde::{Deserialize, Serialize};

/// Describes how the managed host accepts reloaded code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReloadStrategy {
    /// JVM: replace classes via instrumentation / JDWP.
    HotSwapClasses,
    /// JVM: restart class-loader with new class path.
    ClassLoaderRestart,
    /// .NET: unload and reload assembly context.
    AssemblyReload,
    /// Full host restart (fallback).
    FullRestart,
}

/// Host-agent protocol commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HostAgentCommand {
    /// Prepare for reload; flush caches, quiesce.
    PrepareReload { module_id: String },
    /// Deliver the new artifact.
    DeliverArtifact {
        module_id: String,
        artifact_path: String,
        strategy: ReloadStrategy,
    },
    /// Commit the reload; resume event loop.
    CommitReload { module_id: String },
    /// Rollback; restore previous class-loader / assembly.
    RollbackReload { module_id: String },
    /// Export state as JSON from the host.
    ExportState { module_id: String },
    /// Import state JSON into the host.
    ImportState { module_id: String, state: Vec<u8> },
}

/// Response from the host agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostAgentResponse {
    pub success: bool,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub data: Option<Vec<u8>>,
}

/// Pre-reload check for the managed runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedPreReloadCheck {
    pub classes_changed: Vec<String>,
    pub strategy: ReloadStrategy,
    pub requires_quiesce: bool,
    pub estimated_downtime_ms: u64,
}

/// Determine the reload strategy for the given changes.
pub fn determine_reload_strategy(
    changed_files: &[String],
    supports_hot_swap: bool,
) -> ManagedPreReloadCheck {
    let classes_changed: Vec<String> = changed_files
        .iter()
        .filter(|f| f.ends_with(".java") || f.ends_with(".kt") || f.ends_with(".cs"))
        .cloned()
        .collect();

    // Hot-swap is only possible for method-body changes (detected at class level).
    // If structural changes are detected, fall back to classloader restart.
    let strategy = if supports_hot_swap && classes_changed.len() <= 5 {
        ReloadStrategy::HotSwapClasses
    } else if classes_changed.iter().any(|f| f.ends_with(".cs")) {
        ReloadStrategy::AssemblyReload
    } else {
        ReloadStrategy::ClassLoaderRestart
    };

    let requires_quiesce = !matches!(strategy, ReloadStrategy::HotSwapClasses);
    let estimated_downtime_ms = match strategy {
        ReloadStrategy::HotSwapClasses => 50,
        ReloadStrategy::ClassLoaderRestart => 300,
        ReloadStrategy::AssemblyReload => 200,
        ReloadStrategy::FullRestart => 2000,
    };

    ManagedPreReloadCheck {
        classes_changed,
        strategy,
        requires_quiesce,
        estimated_downtime_ms,
    }
}

/// Build the command sequence for a managed reload.
pub fn build_reload_commands(
    module_id: &str,
    artifact_path: &str,
    strategy: ReloadStrategy,
    has_state: bool,
) -> Vec<HostAgentCommand> {
    let mut cmds = Vec::new();

    // Export state before reload if needed
    if has_state {
        cmds.push(HostAgentCommand::ExportState {
            module_id: module_id.into(),
        });
    }

    // Prepare
    cmds.push(HostAgentCommand::PrepareReload {
        module_id: module_id.into(),
    });

    // Deliver
    cmds.push(HostAgentCommand::DeliverArtifact {
        module_id: module_id.into(),
        artifact_path: artifact_path.into(),
        strategy,
    });

    // Commit
    cmds.push(HostAgentCommand::CommitReload {
        module_id: module_id.into(),
    });

    // Import state after reload
    if has_state {
        cmds.push(HostAgentCommand::ImportState {
            module_id: module_id.into(),
            state: vec![], // state bytes injected at execution time
        });
    }

    cmds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_hot_swap_few_classes() {
        let check = determine_reload_strategy(
            &["Main.java".into(), "App.java".into()],
            true,
        );
        assert_eq!(check.strategy, ReloadStrategy::HotSwapClasses);
        assert!(!check.requires_quiesce);
    }

    #[test]
    fn strategy_classloader_many_classes() {
        let files: Vec<String> = (0..10).map(|i| format!("Cls{}.java", i)).collect();
        let check = determine_reload_strategy(&files, true);
        assert_eq!(check.strategy, ReloadStrategy::ClassLoaderRestart);
        assert!(check.requires_quiesce);
    }

    #[test]
    fn strategy_dotnet_assembly() {
        let check = determine_reload_strategy(&["Program.cs".into()], false);
        assert_eq!(check.strategy, ReloadStrategy::AssemblyReload);
    }

    #[test]
    fn command_sequence_with_state() {
        let cmds = build_reload_commands(
            "app",
            "app.jar",
            ReloadStrategy::ClassLoaderRestart,
            true,
        );
        assert_eq!(cmds.len(), 5); // export + prepare + deliver + commit + import
    }

    #[test]
    fn command_sequence_no_state() {
        let cmds = build_reload_commands(
            "app",
            "app.jar",
            ReloadStrategy::HotSwapClasses,
            false,
        );
        assert_eq!(cmds.len(), 3); // prepare + deliver + commit
    }
}
