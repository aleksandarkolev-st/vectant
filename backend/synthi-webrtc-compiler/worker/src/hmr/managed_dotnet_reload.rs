// ============================================================
// MANAGED DOTNET RELOAD
// ============================================================
// .NET-specific reload logic: AssemblyLoadContext-based hot
// reload vs full process restart.  Parallels the JVM
// classloader strategy but for the .NET ecosystem.
// ============================================================

use serde::{Deserialize, Serialize};

/// Kind of .NET assembly change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssemblyChangeKind {
    /// Method body or IL change (hot-reload safe in .NET 6+).
    IlBodyChange,
    /// Added method or property.
    MemberAdded,
    /// Type layout changed (structural).
    TypeLayoutChange,
    /// New assembly reference added.
    NewReference,
    /// Assembly removed.
    AssemblyRemoved,
    /// Unknown.
    Unknown,
}

impl AssemblyChangeKind {
    /// Whether this can be applied via .NET Hot Reload (EnC).
    pub fn is_enc_safe(&self) -> bool {
        matches!(
            self,
            AssemblyChangeKind::IlBodyChange | AssemblyChangeKind::MemberAdded
        )
    }
}

/// Description of a single assembly change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssemblyChange {
    pub assembly_name: String,
    pub kind: AssemblyChangeKind,
}

/// .NET reload strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DotNetReloadStrategy {
    /// Edit-and-Continue (fastest, .NET 6+ only).
    HotReload,
    /// Unload AssemblyLoadContext, load new assembly.
    AssemblyContextReload,
    /// Full process restart.
    ProcessRestart,
}

/// Configuration.
#[derive(Debug, Clone)]
pub struct DotNetStrategyConfig {
    /// Whether runtime supports EnC (.NET 6+).
    pub enc_supported: bool,
    /// Max assemblies for hot reload.
    pub hot_reload_assembly_limit: usize,
}

impl Default for DotNetStrategyConfig {
    fn default() -> Self {
        Self {
            enc_supported: true,
            hot_reload_assembly_limit: 20,
        }
    }
}

/// Decision result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DotNetStrategyDecision {
    pub strategy: DotNetReloadStrategy,
    pub reason: String,
    pub assemblies_affected: usize,
}

/// Decide which .NET reload strategy to use.
pub fn decide_dotnet_strategy(
    changes: &[AssemblyChange],
    config: &DotNetStrategyConfig,
) -> DotNetStrategyDecision {
    if changes.is_empty() {
        return DotNetStrategyDecision {
            strategy: DotNetReloadStrategy::HotReload,
            reason: "no changes".into(),
            assemblies_affected: 0,
        };
    }

    let all_enc_safe = changes.iter().all(|c| c.kind.is_enc_safe());

    if !config.enc_supported || !all_enc_safe {
        let has_type_layout = changes
            .iter()
            .any(|c| c.kind == AssemblyChangeKind::TypeLayoutChange);

        if has_type_layout {
            return DotNetStrategyDecision {
                strategy: DotNetReloadStrategy::ProcessRestart,
                reason: "type layout changes require process restart".into(),
                assemblies_affected: changes.len(),
            };
        }

        return DotNetStrategyDecision {
            strategy: DotNetReloadStrategy::AssemblyContextReload,
            reason: "structural changes require ALC reload".into(),
            assemblies_affected: changes.len(),
        };
    }

    if changes.len() > config.hot_reload_assembly_limit {
        return DotNetStrategyDecision {
            strategy: DotNetReloadStrategy::AssemblyContextReload,
            reason: format!(
                "{} assemblies exceed hot reload limit {}",
                changes.len(),
                config.hot_reload_assembly_limit
            ),
            assemblies_affected: changes.len(),
        };
    }

    DotNetStrategyDecision {
        strategy: DotNetReloadStrategy::HotReload,
        reason: format!("{} EnC-safe changes", changes.len()),
        assemblies_affected: changes.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_change_is_hot_reload() {
        let changes = vec![AssemblyChange {
            assembly_name: "MyApp.dll".into(),
            kind: AssemblyChangeKind::IlBodyChange,
        }];
        let d = decide_dotnet_strategy(&changes, &DotNetStrategyConfig::default());
        assert_eq!(d.strategy, DotNetReloadStrategy::HotReload);
    }

    #[test]
    fn type_layout_requires_restart() {
        let changes = vec![AssemblyChange {
            assembly_name: "MyApp.dll".into(),
            kind: AssemblyChangeKind::TypeLayoutChange,
        }];
        let d = decide_dotnet_strategy(&changes, &DotNetStrategyConfig::default());
        assert_eq!(d.strategy, DotNetReloadStrategy::ProcessRestart);
    }

    #[test]
    fn structural_without_layout_uses_alc() {
        let changes = vec![AssemblyChange {
            assembly_name: "MyApp.dll".into(),
            kind: AssemblyChangeKind::NewReference,
        }];
        let d = decide_dotnet_strategy(&changes, &DotNetStrategyConfig::default());
        assert_eq!(d.strategy, DotNetReloadStrategy::AssemblyContextReload);
    }

    #[test]
    fn enc_not_supported_escalates() {
        let config = DotNetStrategyConfig {
            enc_supported: false,
            ..Default::default()
        };
        let changes = vec![AssemblyChange {
            assembly_name: "MyApp.dll".into(),
            kind: AssemblyChangeKind::IlBodyChange,
        }];
        let d = decide_dotnet_strategy(&changes, &config);
        assert_eq!(d.strategy, DotNetReloadStrategy::AssemblyContextReload);
    }
}
