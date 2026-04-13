// ============================================================
// MODULE DEPENDENCY GRAPH
// ============================================================
// Tracks import/dependency relationships between modules so
// that a change in one file can be propagated to all dependent
// modules for rebuild scope calculation.
// ============================================================


use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// A node in the module dependency graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleNode {
    /// Module name / path.
    pub name: String,
    /// Modules this module imports / depends on.
    pub imports: HashSet<String>,
    /// Content hash for change detection.
    pub content_hash: Option<String>,
}

/// Directed dependency graph (acyclic expected, cycles handled).
#[derive(Debug, Clone, Default)]
pub struct DependencyGraph {
    /// module_name → ModuleNode
    nodes: HashMap<String, ModuleNode>,
    /// Reverse index: module_name → set of modules that depend on it.
    dependents: HashMap<String, HashSet<String>>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add or update a module and its imports.
    pub fn upsert(&mut self, name: &str, imports: HashSet<String>, content_hash: Option<String>) {
        // Remove old reverse edges.
        if let Some(old) = self.nodes.get(name) {
            for imp in &old.imports {
                if let Some(deps) = self.dependents.get_mut(imp) {
                    deps.remove(name);
                }
            }
        }

        // Insert forward edges.
        for imp in &imports {
            self.dependents
                .entry(imp.clone())
                .or_default()
                .insert(name.to_string());
        }

        self.nodes.insert(
            name.to_string(),
            ModuleNode {
                name: name.to_string(),
                imports,
                content_hash,
            },
        );
    }

    /// Remove a module from the graph.
    pub fn remove(&mut self, name: &str) {
        if let Some(node) = self.nodes.remove(name) {
            for imp in &node.imports {
                if let Some(deps) = self.dependents.get_mut(imp) {
                    deps.remove(name);
                }
            }
        }
        self.dependents.remove(name);
    }

    /// Get direct dependents (modules that import `name`).
    pub fn direct_dependents(&self, name: &str) -> HashSet<String> {
        self.dependents
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    /// Get transitive closure of all modules affected by changing `name`.
    /// Uses BFS to walk the reverse dependency edges.
    pub fn affected_by(&self, name: &str) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();

        visited.insert(name.to_string());
        queue.push_back(name.to_string());

        while let Some(current) = queue.pop_front() {
            if let Some(deps) = self.dependents.get(&current) {
                for dep in deps {
                    if visited.insert(dep.clone()) {
                        queue.push_back(dep.clone());
                    }
                }
            }
        }

        visited
    }

    /// Get all modules affected by a set of changed files.
    pub fn affected_by_many(&self, changed: &[String]) -> HashSet<String> {
        let mut result = HashSet::new();
        for name in changed {
            result.extend(self.affected_by(name));
        }
        result
    }

    /// Number of modules.
    pub fn module_count(&self) -> usize {
        self.nodes.len()
    }

    /// Whether a module exists in the graph.
    pub fn contains(&self, name: &str) -> bool {
        self.nodes.contains_key(name)
    }

    /// Get a module node.
    pub fn get(&self, name: &str) -> Option<&ModuleNode> {
        self.nodes.get(name)
    }

    /// Detect cycles (returns first cycle found, or None).
    pub fn find_cycle(&self) -> Option<Vec<String>> {
        let mut visited = HashSet::new();
        let mut stack = HashSet::new();
        let mut path = Vec::new();

        for name in self.nodes.keys() {
            if !visited.contains(name) {
                if let Some(cycle) = self.dfs_cycle(name, &mut visited, &mut stack, &mut path) {
                    return Some(cycle);
                }
            }
        }
        None
    }

    fn dfs_cycle(
        &self,
        name: &str,
        visited: &mut HashSet<String>,
        stack: &mut HashSet<String>,
        path: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        visited.insert(name.to_string());
        stack.insert(name.to_string());
        path.push(name.to_string());

        if let Some(node) = self.nodes.get(name) {
            for imp in &node.imports {
                if !visited.contains(imp) {
                    if let Some(cycle) = self.dfs_cycle(imp, visited, stack, path) {
                        return Some(cycle);
                    }
                } else if stack.contains(imp) {
                    // Found a cycle
                    let start = path.iter().position(|p| p == imp).unwrap_or(0);
                    let mut cycle: Vec<String> = path[start..].to_vec();
                    cycle.push(imp.clone());
                    return Some(cycle);
                }
            }
        }

        stack.remove(name);
        path.pop();
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_dependents() {
        let mut g = DependencyGraph::new();
        g.upsert("a", ["b".into(), "c".into()].into(), None);
        g.upsert("d", ["b".into()].into(), None);

        let deps = g.direct_dependents("b");
        assert!(deps.contains("a"));
        assert!(deps.contains("d"));
        assert!(!deps.contains("c"));
    }

    #[test]
    fn transitive_affected() {
        let mut g = DependencyGraph::new();
        // a → b → c
        g.upsert("a", ["b".into()].into(), None);
        g.upsert("b", ["c".into()].into(), None);
        g.upsert("c", HashSet::new(), None);

        let affected = g.affected_by("c");
        assert!(affected.contains("c"));
        assert!(affected.contains("b"));
        assert!(affected.contains("a"));
    }

    #[test]
    fn remove_module() {
        let mut g = DependencyGraph::new();
        g.upsert("a", ["b".into()].into(), None);
        assert_eq!(g.direct_dependents("b").len(), 1);

        g.remove("a");
        assert_eq!(g.direct_dependents("b").len(), 0);
        assert!(!g.contains("a"));
    }

    #[test]
    fn cycle_detection() {
        let mut g = DependencyGraph::new();
        g.upsert("a", ["b".into()].into(), None);
        g.upsert("b", ["c".into()].into(), None);
        g.upsert("c", ["a".into()].into(), None);

        assert!(g.find_cycle().is_some());
    }

    #[test]
    fn no_cycle() {
        let mut g = DependencyGraph::new();
        g.upsert("a", ["b".into()].into(), None);
        g.upsert("b", ["c".into()].into(), None);
        g.upsert("c", HashSet::new(), None);

        assert!(g.find_cycle().is_none());
    }
}
