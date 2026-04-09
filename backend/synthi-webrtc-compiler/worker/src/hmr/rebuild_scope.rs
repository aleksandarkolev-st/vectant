// ============================================================
// REBUILD SCOPE CALCULATOR
// ============================================================
// Given classified dirty files and the dependency graph,
// calculates the minimal rebuild scope (None / GuiOnly /
// CoreOnly / Both / FullReload).  This is the canonical
// scope calculator that replaces the ad-hoc hash comparison
// in handler.rs.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::hmr::dependency_graph::DependencyGraph;
use crate::hmr::dirty_classifier::{DirtyFile, FileClass};

/// Scope of what needs to be rebuilt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RebuildScope {
    /// Nothing changed that affects the build.
    None,
    /// Only GUI modules changed.
    GuiOnly,
    /// Only core modules changed.
    CoreOnly,
    /// Both core and GUI affected.
    Both,
    /// Full reload required (config change, shared header, etc.).
    FullReload,
}

impl RebuildScope {
    /// Whether this scope includes core modules.
    pub fn includes_core(&self) -> bool {
        matches!(self, RebuildScope::CoreOnly | RebuildScope::Both | RebuildScope::FullReload)
    }

    /// Whether this scope includes GUI modules.
    pub fn includes_gui(&self) -> bool {
        matches!(self, RebuildScope::GuiOnly | RebuildScope::Both | RebuildScope::FullReload)
    }

    /// Merge two scopes (union).
    pub fn merge(&self, other: &RebuildScope) -> RebuildScope {
        match (self, other) {
            (RebuildScope::None, s) | (s, RebuildScope::None) => *s,
            (RebuildScope::FullReload, _) | (_, RebuildScope::FullReload) => RebuildScope::FullReload,
            (RebuildScope::Both, _) | (_, RebuildScope::Both) => RebuildScope::Both,
            (RebuildScope::GuiOnly, RebuildScope::CoreOnly)
            | (RebuildScope::CoreOnly, RebuildScope::GuiOnly) => RebuildScope::Both,
            (RebuildScope::CoreOnly, RebuildScope::CoreOnly) => RebuildScope::CoreOnly,
            (RebuildScope::GuiOnly, RebuildScope::GuiOnly) => RebuildScope::GuiOnly,
        }
    }
}

/// Input to the scope calculator.
#[derive(Debug, Clone)]
pub struct ScopeInput<'a> {
    /// Classified dirty files from the current compilation.
    pub dirty_files: &'a [DirtyFile],
    /// Module dependency graph (optional; if None, no transitive analysis).
    pub dep_graph: Option<&'a DependencyGraph>,
}

/// Output of the scope calculator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeResult {
    pub scope: RebuildScope,
    pub affected_modules: HashSet<String>,
    pub has_shared_change: bool,
    pub has_config_change: bool,
    pub dirty_core: Vec<String>,
    pub dirty_gui: Vec<String>,
}

/// Calculate the rebuild scope from dirty files.
pub fn calculate_rebuild_scope(input: &ScopeInput) -> ScopeResult {
    let mut has_core = false;
    let mut has_gui = false;
    let mut has_shared = false;
    let mut has_config = false;
    let mut dirty_core = Vec::new();
    let mut dirty_gui = Vec::new();
    let mut affected = HashSet::new();

    for f in input.dirty_files {
        if !f.class.triggers_rebuild() {
            continue;
        }

        affected.insert(f.path.clone());

        match f.class {
            FileClass::Core => {
                has_core = true;
                dirty_core.push(f.path.clone());
            }
            FileClass::Gui => {
                has_gui = true;
                dirty_gui.push(f.path.clone());
            }
            FileClass::Shared => {
                has_shared = true;
            }
            FileClass::Config => {
                has_config = true;
            }
            _ => {}
        }
    }

    // Shared header change → full reload
    if has_shared || has_config {
        // With dep graph, figure out what's actually affected
        if let Some(graph) = input.dep_graph {
            let shared_files: Vec<String> = input
                .dirty_files
                .iter()
                .filter(|f| f.class == FileClass::Shared || f.class == FileClass::Config)
                .map(|f| f.path.clone())
                .collect();
            let transitive = graph.affected_by_many(&shared_files);
            affected.extend(transitive);
        }

        return ScopeResult {
            scope: if has_config {
                RebuildScope::FullReload
            } else {
                RebuildScope::Both
            },
            affected_modules: affected,
            has_shared_change: has_shared,
            has_config_change: has_config,
            dirty_core,
            dirty_gui,
        };
    }

    // Add transitive dependencies if graph available
    if let Some(graph) = input.dep_graph {
        let changed_paths: Vec<String> = input
            .dirty_files
            .iter()
            .filter(|f| f.class.triggers_rebuild())
            .map(|f| f.path.clone())
            .collect();
        let transitive = graph.affected_by_many(&changed_paths);
        affected.extend(transitive);
    }

    let scope = match (has_core, has_gui) {
        (false, false) => RebuildScope::None,
        (true, false) => RebuildScope::CoreOnly,
        (false, true) => RebuildScope::GuiOnly,
        (true, true) => RebuildScope::Both,
    };

    ScopeResult {
        scope,
        affected_modules: affected,
        has_shared_change: false,
        has_config_change: false,
        dirty_core,
        dirty_gui,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::dirty_classifier::DirtyFile;

    #[test]
    fn gui_only() {
        let dirty = vec![DirtyFile {
            path: "src/gui/window.rs".into(),
            class: FileClass::Gui,
            content_hash: None,
        }];
        let result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: &dirty,
            dep_graph: None,
        });
        assert_eq!(result.scope, RebuildScope::GuiOnly);
    }

    #[test]
    fn core_only() {
        let dirty = vec![DirtyFile {
            path: "src/engine.rs".into(),
            class: FileClass::Core,
            content_hash: None,
        }];
        let result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: &dirty,
            dep_graph: None,
        });
        assert_eq!(result.scope, RebuildScope::CoreOnly);
    }

    #[test]
    fn both() {
        let dirty = vec![
            DirtyFile { path: "src/main.rs".into(), class: FileClass::Core, content_hash: None },
            DirtyFile { path: "src/gui/win.rs".into(), class: FileClass::Gui, content_hash: None },
        ];
        let result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: &dirty,
            dep_graph: None,
        });
        assert_eq!(result.scope, RebuildScope::Both);
    }

    #[test]
    fn config_triggers_full() {
        let dirty = vec![DirtyFile {
            path: "Cargo.toml".into(),
            class: FileClass::Config,
            content_hash: None,
        }];
        let result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: &dirty,
            dep_graph: None,
        });
        assert_eq!(result.scope, RebuildScope::FullReload);
        assert!(result.has_config_change);
    }

    #[test]
    fn irrelevant_means_none() {
        let dirty = vec![DirtyFile {
            path: "README.md".into(),
            class: FileClass::Irrelevant,
            content_hash: None,
        }];
        let result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: &dirty,
            dep_graph: None,
        });
        assert_eq!(result.scope, RebuildScope::None);
    }

    #[test]
    fn merge_scopes() {
        assert_eq!(RebuildScope::None.merge(&RebuildScope::GuiOnly), RebuildScope::GuiOnly);
        assert_eq!(RebuildScope::CoreOnly.merge(&RebuildScope::GuiOnly), RebuildScope::Both);
        assert_eq!(RebuildScope::Both.merge(&RebuildScope::CoreOnly), RebuildScope::Both);
    }
}
