// ============================================================
// STATE MIGRATION VERSIONING
// ============================================================
// Manages a registry of state migration functions between
// schema versions.  Supports forward migration chains,
// rollback paths, and version gap detection.
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

use crate::hmr::state_manager::SchemaVersion;

/// A registered migration step.
#[derive(Debug, Clone)]
pub struct MigrationStep {
    pub from: SchemaVersion,
    pub to: SchemaVersion,
    /// Description of what this migration does.
    pub description: String,
    /// Whether this step is reversible.
    pub reversible: bool,
    /// Field additions.
    pub added_fields: Vec<FieldChange>,
    /// Field removals.
    pub removed_fields: Vec<FieldChange>,
    /// Field renames.
    pub renamed_fields: Vec<(String, String)>,
    /// Default values for new fields.
    pub defaults: HashMap<String, serde_json::Value>,
}

/// Describes a field change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldChange {
    pub field_name: String,
    pub field_type: String,
    pub default_value: Option<serde_json::Value>,
}

/// Migration path from one version to another.
#[derive(Debug, Clone)]
pub struct MigrationPath {
    pub steps: Vec<MigrationStep>,
    pub from: SchemaVersion,
    pub to: SchemaVersion,
    /// Whether the entire path is reversible.
    pub fully_reversible: bool,
}

/// Error when no valid path exists.
#[derive(Debug, Clone)]
pub enum MigrationPathError {
    NoPath { from: SchemaVersion, to: SchemaVersion },
}

impl std::fmt::Display for MigrationPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoPath { from, to } => write!(f, "no migration path from {} to {}", from, to),
        }
    }
}

/// Registry of all known migration steps.
pub struct MigrationRegistry {
    /// Forward migrations: (from, to) → step.
    forward: HashMap<(SchemaVersion, SchemaVersion), MigrationStep>,
    /// Reverse migrations: (to, from) → step (auto-derived if reversible).
    reverse: HashMap<(SchemaVersion, SchemaVersion), MigrationStep>,
}

impl MigrationRegistry {
    pub fn new() -> Self {
        Self {
            forward: HashMap::new(),
            reverse: HashMap::new(),
        }
    }

    /// Register a forward migration step.
    pub fn register(&mut self, step: MigrationStep) {
        let from = step.from;
        let to = step.to;

        // If reversible, auto-derive reverse step
        if step.reversible {
            let reverse = MigrationStep {
                from: to,
                to: from,
                description: format!("rollback: {}", step.description),
                reversible: true,
                added_fields: step.removed_fields.clone(),
                removed_fields: step.added_fields.clone(),
                renamed_fields: step.renamed_fields.iter().map(|(a, b)| (b.clone(), a.clone())).collect(),
                defaults: HashMap::new(),
            };
            self.reverse.insert((to, from), reverse);
        }

        self.forward.insert((from, to), step);
    }

    /// Find a forward migration path using BFS.
    pub fn find_path(
        &self,
        from: SchemaVersion,
        to: SchemaVersion,
    ) -> Result<MigrationPath, MigrationPathError> {
        if from == to {
            return Ok(MigrationPath {
                steps: vec![],
                from,
                to,
                fully_reversible: true,
            });
        }

        // BFS over forward edges
        let mut queue: VecDeque<(SchemaVersion, Vec<MigrationStep>)> = VecDeque::from([(from, vec![])]);
        let mut visited: HashSet<SchemaVersion> = HashSet::new();
        visited.insert(from);

        while let Some((current, path)) = queue.pop_front() {
            // Find all forward steps from current
            for ((f, t), step) in &self.forward {
                if *f == current && !visited.contains(t) {
                    let mut new_path = path.clone();
                    new_path.push(step.clone());

                    if *t == to {
                        let fully_reversible = new_path.iter().all(|s| s.reversible);
                        return Ok(MigrationPath {
                            steps: new_path,
                            from,
                            to,
                            fully_reversible,
                        });
                    }

                    visited.insert(*t);
                    queue.push_back((*t, new_path));
                }
            }
        }

        Err(MigrationPathError::NoPath { from, to })
    }

    /// Find a rollback path (reverse direction).
    pub fn find_rollback_path(
        &self,
        from: SchemaVersion,
        to: SchemaVersion,
    ) -> Result<MigrationPath, MigrationPathError> {
        if from == to {
            return Ok(MigrationPath {
                steps: vec![],
                from,
                to,
                fully_reversible: true,
            });
        }

        // BFS over reverse edges
        let mut queue: VecDeque<(SchemaVersion, Vec<MigrationStep>)> = VecDeque::from([(from, vec![])]);
        let mut visited: HashSet<SchemaVersion> = HashSet::new();
        visited.insert(from);

        while let Some((current, path)) = queue.pop_front() {
            for ((f, t), step) in &self.reverse {
                if *f == current && !visited.contains(t) {
                    let mut new_path = path.clone();
                    new_path.push(step.clone());

                    if *t == to {
                        return Ok(MigrationPath {
                            steps: new_path,
                            from,
                            to,
                            fully_reversible: true,
                        });
                    }

                    visited.insert(*t);
                    queue.push_back((*t, new_path));
                }
            }
        }

        Err(MigrationPathError::NoPath { from, to })
    }

    /// Apply a migration path to a JSON state.
    pub fn apply_path(
        &self,
        state: &serde_json::Value,
        path: &MigrationPath,
    ) -> Result<serde_json::Value, String> {
        let mut current = state.clone();

        for step in &path.steps {
            current = apply_step(&current, step)?;
        }

        Ok(current)
    }
}

/// Apply a single migration step to a JSON object.
fn apply_step(
    state: &serde_json::Value,
    step: &MigrationStep,
) -> Result<serde_json::Value, String> {
    let mut obj = match state.as_object() {
        Some(map) => map.clone(),
        None => return Err("state is not a JSON object".into()),
    };

    // Remove fields
    for field in &step.removed_fields {
        obj.remove(&field.field_name);
    }

    // Rename fields
    for (old, new) in &step.renamed_fields {
        if let Some(val) = obj.remove(old) {
            obj.insert(new.clone(), val);
        }
    }

    // Add new fields with defaults
    for field in &step.added_fields {
        if !obj.contains_key(&field.field_name) {
            let default = step
                .defaults
                .get(&field.field_name)
                .or(field.default_value.as_ref())
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            obj.insert(field.field_name.clone(), default);
        }
    }

    Ok(serde_json::Value::Object(obj))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_forward_path() {
        let mut reg = MigrationRegistry::new();
        let v1 = SchemaVersion::new(1, 0, 0);
        let v2 = SchemaVersion::new(1, 1, 0);

        reg.register(MigrationStep {
            from: v1,
            to: v2,
            description: "add score field".into(),
            reversible: true,
            added_fields: vec![FieldChange {
                field_name: "score".into(),
                field_type: "u32".into(),
                default_value: Some(serde_json::json!(0)),
            }],
            removed_fields: vec![],
            renamed_fields: vec![],
            defaults: {
                let mut m = HashMap::new();
                m.insert("score".into(), serde_json::json!(0));
                m
            },
        });

        let path = reg.find_path(v1, v2).unwrap();
        assert_eq!(path.steps.len(), 1);
        assert!(path.fully_reversible);

        let state = serde_json::json!({"counter": 42});
        let migrated = reg.apply_path(&state, &path).unwrap();
        assert_eq!(migrated["counter"], 42);
        assert_eq!(migrated["score"], 0);
    }

    #[test]
    fn rollback_path() {
        let mut reg = MigrationRegistry::new();
        let v1 = SchemaVersion::new(1, 0, 0);
        let v2 = SchemaVersion::new(1, 1, 0);

        reg.register(MigrationStep {
            from: v1,
            to: v2,
            description: "add score".into(),
            reversible: true,
            added_fields: vec![FieldChange {
                field_name: "score".into(),
                field_type: "u32".into(),
                default_value: Some(serde_json::json!(0)),
            }],
            removed_fields: vec![],
            renamed_fields: vec![],
            defaults: HashMap::new(),
        });

        let rollback = reg.find_rollback_path(v2, v1).unwrap();
        assert_eq!(rollback.steps.len(), 1);

        // Rollback should remove the added field
        let state = serde_json::json!({"counter": 42, "score": 100});
        let rolled = reg.apply_path(&state, &rollback).unwrap();
        assert_eq!(rolled["counter"], 42);
        assert!(rolled.get("score").is_none());
    }

    #[test]
    fn no_path() {
        let reg = MigrationRegistry::new();
        let v1 = SchemaVersion::new(1, 0, 0);
        let v3 = SchemaVersion::new(3, 0, 0);
        assert!(reg.find_path(v1, v3).is_err());
    }
}
