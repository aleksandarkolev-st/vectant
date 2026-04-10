// ============================================================
// SHARED HEADER DETECTION
// ============================================================
// Detects shared header files that bridge core and GUI modules.
// A change to a shared header escalates rebuild scope from
// GuiOnly/CoreOnly to Both.  Uses the dependency graph to
// determine if a Shared-classified file actually links the
// two module groups.
// ============================================================


use crate::hmr::dependency_graph::DependencyGraph;
use crate::hmr::dirty_classifier::FileClass;
use crate::hmr::rebuild_scope::RebuildScope;

/// Result of shared header analysis.
#[derive(Debug, Clone)]
pub struct SharedHeaderAnalysis {
    /// Shared headers that bridge core and GUI.
    pub bridging_headers: Vec<String>,
    /// Shared headers that are core-only dependents.
    pub core_only_shared: Vec<String>,
    /// Shared headers that are GUI-only dependents.
    pub gui_only_shared: Vec<String>,
    /// Recommended scope escalation.
    pub escalated_scope: Option<RebuildScope>,
}

/// Analyze shared headers to determine if they require scope escalation.
///
/// A shared header "bridges" if it has dependents in both core and GUI
/// module groups.
pub fn analyze_shared_headers(
    shared_paths: &[String],
    dep_graph: &DependencyGraph,
    classify_fn: impl Fn(&str) -> FileClass,
) -> SharedHeaderAnalysis {
    let mut bridging = Vec::new();
    let mut core_only = Vec::new();
    let mut gui_only = Vec::new();

    for path in shared_paths {
        let dependents = dep_graph.direct_dependents(path);
        if dependents.is_empty() {
            // No known dependents — conservative: treat as bridging
            bridging.push(path.clone());
            continue;
        }

        let mut has_core = false;
        let mut has_gui = false;

        for dep in &dependents {
            match classify_fn(dep) {
                FileClass::Core => has_core = true,
                FileClass::Gui => has_gui = true,
                FileClass::Shared => {
                    // Shared depending on shared — check transitively
                    has_core = true;
                    has_gui = true;
                }
                _ => {}
            }
        }

        match (has_core, has_gui) {
            (true, true) => bridging.push(path.clone()),
            (true, false) => core_only.push(path.clone()),
            (false, true) => gui_only.push(path.clone()),
            (false, false) => {} // No relevant dependents
        }
    }

    let escalated_scope = if !bridging.is_empty() {
        Some(RebuildScope::Both)
    } else {
        match (!core_only.is_empty(), !gui_only.is_empty()) {
            (true, true) => Some(RebuildScope::Both),
            (true, false) => Some(RebuildScope::CoreOnly),
            (false, true) => Some(RebuildScope::GuiOnly),
            (false, false) => None,
        }
    };

    SharedHeaderAnalysis {
        bridging_headers: bridging,
        core_only_shared: core_only,
        gui_only_shared: gui_only,
        escalated_scope,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_classify(path: &str) -> FileClass {
        if path.contains("gui") {
            FileClass::Gui
        } else if path.contains("core") {
            FileClass::Core
        } else {
            FileClass::Shared
        }
    }

    #[test]
    fn bridging_header() {
        let mut graph = DependencyGraph::new();
        graph.upsert("core/engine.rs", ["shared/types.h".into()].into(), None);
        graph.upsert("gui/render.rs", ["shared/types.h".into()].into(), None);

        let analysis = analyze_shared_headers(
            &["shared/types.h".into()],
            &graph,
            mock_classify,
        );
        assert_eq!(analysis.bridging_headers.len(), 1);
        assert_eq!(analysis.escalated_scope, Some(RebuildScope::Both));
    }

    #[test]
    fn core_only_shared() {
        let mut graph = DependencyGraph::new();
        graph.upsert("core/engine.rs", ["shared/math.h".into()].into(), None);
        graph.upsert("core/physics.rs", ["shared/math.h".into()].into(), None);

        let analysis = analyze_shared_headers(
            &["shared/math.h".into()],
            &graph,
            mock_classify,
        );
        assert_eq!(analysis.core_only_shared.len(), 1);
        assert_eq!(analysis.escalated_scope, Some(RebuildScope::CoreOnly));
    }

    #[test]
    fn no_dependents_is_bridging() {
        let graph = DependencyGraph::new();
        let analysis = analyze_shared_headers(
            &["shared/unknown.h".into()],
            &graph,
            mock_classify,
        );
        // Conservative: no dependents → bridging
        assert_eq!(analysis.bridging_headers.len(), 1);
    }
}
