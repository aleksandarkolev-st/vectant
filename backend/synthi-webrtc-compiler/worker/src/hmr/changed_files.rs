// ============================================================
// CHANGED FILE SOURCE
// ============================================================
// Produces the set of changed files between compilations.
// Bridges the file watcher (fsWatcherService) notifications
// with the dirty classifier to produce DirtyFile sets for
// rebuild scope decisions.
// ============================================================

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hmr::dirty_classifier::{classify_file, DirtyFile, FileClass};

/// Type of file change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
}

/// A raw file change event from the watcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub change_type: ChangeType,
    pub content_hash: Option<String>,
}

/// Accumulated change set for a compilation cycle.
#[derive(Debug, Clone, Default)]
pub struct ChangeSet {
    changes: Vec<FileChange>,
    classified: Vec<DirtyFile>,
    prev_hashes: HashMap<String, String>,
}

impl ChangeSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set previous content hashes for meaningful diff.
    pub fn set_prev_hashes(&mut self, hashes: HashMap<String, String>) {
        self.prev_hashes = hashes;
    }

    /// Add a file change. Deduplicates by path (last write wins).
    pub fn add(&mut self, change: FileChange) {
        // Remove previous change for same path
        self.changes.retain(|c| c.path != change.path);
        self.changes.push(change);
        // Invalidate classification cache
        self.classified.clear();
    }

    /// Classify all changes and return DirtyFiles.
    pub fn classify(&mut self) -> &[DirtyFile] {
        if self.classified.is_empty() && !self.changes.is_empty() {
            self.classified = self
                .changes
                .iter()
                .map(|c| DirtyFile {
                    path: c.path.clone(),
                    class: classify_file(&c.path),
                    content_hash: c.content_hash.clone(),
                })
                .collect();
        }
        &self.classified
    }

    /// Whether any change triggers a rebuild.
    pub fn has_rebuild_trigger(&mut self) -> bool {
        self.classify().iter().any(|f| f.class.triggers_rebuild())
    }

    /// Changes that actually modify content (hash differs from previous).
    pub fn meaningful_changes(&self) -> Vec<&FileChange> {
        self.changes
            .iter()
            .filter(|c| {
                match c.change_type {
                    ChangeType::Added | ChangeType::Deleted => true,
                    ChangeType::Modified => {
                        // If we have hashes, check if content actually changed
                        match (&c.content_hash, self.prev_hashes.get(&c.path)) {
                            (Some(new), Some(old)) => new != old,
                            _ => true, // No hash info = assume changed
                        }
                    }
                }
            })
            .collect()
    }

    /// File paths grouped by classification.
    pub fn by_class(&mut self) -> HashMap<FileClass, Vec<String>> {
        let mut result: HashMap<FileClass, Vec<String>> = HashMap::new();
        for f in self.classify() {
            result
                .entry(f.class)
                .or_default()
                .push(f.path.clone());
        }
        result
    }

    /// Total number of changes.
    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// Clear all changes for next cycle.
    pub fn clear(&mut self) {
        self.changes.clear();
        self.classified.clear();
    }

    /// Raw changes.
    pub fn changes(&self) -> &[FileChange] {
        &self.changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplication() {
        let mut cs = ChangeSet::new();
        cs.add(FileChange {
            path: "src/main.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: Some("hash1".into()),
        });
        cs.add(FileChange {
            path: "src/main.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: Some("hash2".into()),
        });
        assert_eq!(cs.len(), 1);
        assert_eq!(cs.changes()[0].content_hash.as_deref(), Some("hash2"));
    }

    #[test]
    fn classification() {
        let mut cs = ChangeSet::new();
        cs.add(FileChange {
            path: "src/gui/window.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: None,
        });
        cs.add(FileChange {
            path: "README.md".into(),
            change_type: ChangeType::Modified,
            content_hash: None,
        });

        assert!(cs.has_rebuild_trigger());
        let by_class = cs.by_class();
        assert!(by_class.get(&FileClass::Gui).is_some());
        assert!(by_class.get(&FileClass::Irrelevant).is_some());
    }

    #[test]
    fn meaningful_changes() {
        let mut cs = ChangeSet::new();
        cs.set_prev_hashes({
            let mut m = HashMap::new();
            m.insert("src/main.rs".into(), "old_hash".into());
            m
        });

        // Same hash = not meaningful
        cs.add(FileChange {
            path: "src/main.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: Some("old_hash".into()),
        });
        assert_eq!(cs.meaningful_changes().len(), 0);

        // Different hash = meaningful
        cs.add(FileChange {
            path: "src/main.rs".into(),
            change_type: ChangeType::Modified,
            content_hash: Some("new_hash".into()),
        });
        assert_eq!(cs.meaningful_changes().len(), 1);
    }
}
