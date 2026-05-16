// ============================================================
// WAVE 07 INTEGRATION TESTS
// ============================================================
// End-to-end scenarios for dirty-unit detection pipeline:
// file change → classify → dep graph → scope → planner bridge.
// ============================================================

#[cfg(test)]
mod tests {
    use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
    use crate::hmr::changed_files::{ChangeSet, ChangeType, FileChange};
    use crate::hmr::dependency_graph::DependencyGraph;
    use crate::hmr::dirty_classifier::{classify_file, FileClass};
    use crate::hmr::planner_decision::ReloadDecision;
    use crate::hmr::rebuild_scope::{calculate_rebuild_scope, RebuildScope, ScopeInput};
    use crate::hmr::scope_planner_bridge::{scope_to_planner, ScopePlannerInput};
    use crate::hmr::shared_header_detect::analyze_shared_headers;
    use std::collections::HashSet;

    // ── Scenario 1: GUI edit → warm reload ──────────────────────

    #[test]
    fn scenario_gui_edit_warm_reload() {
        // Step 1: File change arrives
        let mut cs = ChangeSet::new();
        cs.add(FileChange {
            path: "src/gui/panel.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: Some("abc123".into()),
        });

        // Step 2: Classify
        let dirty = cs.classify();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].class, FileClass::Gui);

        // Step 3: Calculate scope
        let scope_result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: dirty,
            dep_graph: None,
        });
        assert_eq!(scope_result.scope, RebuildScope::GuiOnly);

        // Step 4: Map to planner
        let planner_output = scope_to_planner(&ScopePlannerInput {
            scope: scope_result,
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: true,
            abi_changed: false,
        });
        assert_eq!(planner_output.decision, ReloadDecision::WarmReload);
    }

    // ── Scenario 2: Shared header → Both via dep graph ──────────

    #[test]
    fn scenario_shared_header_both() {
        let mut graph = DependencyGraph::new();
        graph.upsert(
            "src/core/engine.rs",
            ["src/shared/types.rs".into()].into(),
            None,
        );
        graph.upsert(
            "src/gui/render.rs",
            ["src/shared/types.rs".into()].into(),
            None,
        );

        let analysis =
            analyze_shared_headers(&["src/shared/types.rs".into()], &graph, classify_file);
        assert_eq!(analysis.escalated_scope, Some(RebuildScope::Both));
    }

    // ── Scenario 3: Config change → full restart ────────────────

    #[test]
    fn scenario_config_full_restart() {
        let mut cs = ChangeSet::new();
        cs.add(FileChange {
            path: "Cargo.toml".into(),
            change_type: ChangeType::Modified,
            content_hash: None,
        });

        let dirty = cs.classify();
        let scope_result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: dirty,
            dep_graph: None,
        });
        assert_eq!(scope_result.scope, RebuildScope::FullReload);

        let planner_output = scope_to_planner(&ScopePlannerInput {
            scope: scope_result,
            adapter_family: AdapterFamily::DynamicLibrary,
            capability_tier: CapabilityTier::Tier2,
            has_snapshot: true,
            abi_changed: false,
        });
        assert_eq!(planner_output.decision, ReloadDecision::FullRestart);
    }

    // ── Scenario 4: Transitive dependency propagation ───────────

    #[test]
    fn scenario_transitive_deps() {
        let mut graph = DependencyGraph::new();
        // a → b → c (all core)
        graph.upsert("src/a.rs", ["src/b.rs".into()].into(), None);
        graph.upsert("src/b.rs", ["src/c.rs".into()].into(), None);
        graph.upsert("src/c.rs", HashSet::new(), None);

        // Changing c should affect a and b transitively
        let affected = graph.affected_by("src/c.rs");
        assert!(affected.contains("src/a.rs"));
        assert!(affected.contains("src/b.rs"));
        assert!(affected.contains("src/c.rs"));
    }

    // ── Scenario 5: Irrelevant files skip rebuild ───────────────

    #[test]
    fn scenario_irrelevant_no_rebuild() {
        let mut cs = ChangeSet::new();
        cs.add(FileChange {
            path: "README.md".into(),
            change_type: ChangeType::Modified,
            content_hash: None,
        });
        cs.add(FileChange {
            path: "docs/NOTES.txt".into(),
            change_type: ChangeType::Modified,
            content_hash: None,
        });

        assert!(!cs.has_rebuild_trigger());
        let dirty = cs.classify();
        let scope_result = calculate_rebuild_scope(&ScopeInput {
            dirty_files: dirty,
            dep_graph: None,
        });
        assert_eq!(scope_result.scope, RebuildScope::None);
    }
}
