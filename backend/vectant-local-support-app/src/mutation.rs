//! Restricted workspace mutation transactions for Full Access.
//!
//! There is intentionally no shell-write path. A mutation is addressed by a
//! current graph node and hash, written through a same-volume temporary file,
//! journaled locally, and reversible only by transaction id.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::full_access::{safe_workspace_relative_path, GraphNode, GraphNodeState, RiskClass};
use crate::scanner::SecretScanner;
use crate::workspace::{resolve_relative, WorkspacePolicy};

pub const MAX_MUTATION_BYTES: usize = 262_144;
pub const MAX_MUTATION_TRANSACTIONS: usize = 64;
const MAX_JOURNAL_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationRequest {
    pub request_id: String,
    pub node_id: String,
    pub expected_content_hash: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationTransaction {
    pub transaction_id: String,
    pub request_id: String,
    pub node_id: String,
    pub relative_path: String,
    pub before_hash: String,
    pub after_hash: String,
    pub bytes_written: usize,
    /// Content-free, restart-safe summary for the native desktop review.
    /// Exact before/after bodies remain in the private recovery file and are
    /// never serialized into relay or audit payloads.
    #[serde(default)]
    pub diff_summary: MutationDiffSummary,
    pub created_at: DateTime<Utc>,
    pub recovery_expires_at: DateTime<Utc>,
    #[serde(skip)]
    recovery_path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationDiffSummary {
    pub lines_added: usize,
    pub lines_removed: usize,
    pub lines_unchanged: usize,
    pub changed: bool,
}

/// On-disk transaction metadata. Recovery content remains in the sibling backup
/// file; the journal intentionally records hashes and identifiers only.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MutationJournal {
    transaction: MutationTransaction,
    recovery_file: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutationError {
    InvalidRequest,
    TargetDenied,
    StaleTarget,
    ScannerDenied,
    TransactionLimit,
    RecoveryUnavailable,
    Conflict,
    Io,
}

pub struct WorkspaceMutationBroker {
    workspace: WorkspacePolicy,
    scanner: SecretScanner,
    retention: Duration,
    transactions: HashMap<String, MutationTransaction>,
    storage_error: bool,
}

impl WorkspaceMutationBroker {
    pub fn new(workspace: WorkspacePolicy, retention: Duration) -> Self {
        let mut broker = Self {
            workspace,
            scanner: SecretScanner::default(),
            retention,
            transactions: HashMap::new(),
            storage_error: false,
        };
        broker.load_recovery_journals();
        broker.prune();
        broker
    }

    pub fn apply(
        &mut self,
        graph: &HashMap<String, GraphNode>,
        request: MutationRequest,
    ) -> Result<MutationTransaction, MutationError> {
        self.ensure_storage()?;
        self.prune();
        if self.transactions.len() >= MAX_MUTATION_TRANSACTIONS
            || !safe_id(&request.request_id)
            || !safe_id(&request.node_id)
            || request.replacement.len() > MAX_MUTATION_BYTES
            || request.replacement.contains('\0')
        {
            return Err(MutationError::InvalidRequest);
        }
        let node = graph
            .get(&request.node_id)
            .ok_or(MutationError::TargetDenied)?;
        if !matches!(
            node.state,
            GraphNodeState::Available | GraphNodeState::AutoRequestable
        ) || node.classification == RiskClass::E
            || !safe_workspace_relative_path(&node.relative_path)
        {
            return Err(MutationError::TargetDenied);
        }
        let (before, current_hash) = self
            .workspace
            .read_graph_node(node, MAX_MUTATION_BYTES as u64)
            .map_err(|_| MutationError::StaleTarget)?;
        if current_hash != request.expected_content_hash || node.content_hash != current_hash {
            return Err(MutationError::StaleTarget);
        }
        if !self
            .scanner
            .try_scan(&request.replacement)
            .map_err(|_| MutationError::ScannerDenied)?
            .findings
            .is_empty()
        {
            return Err(MutationError::ScannerDenied);
        }
        let target = resolve_relative(self.workspace.root(), &node.relative_path)
            .map_err(|_| MutationError::TargetDenied)?;
        let transaction_id = new_id();
        let recovery_path = self.recovery_path(&transaction_id)?;
        write_new_file(&recovery_path, before.as_bytes()).map_err(|_| MutationError::Io)?;
        let transaction = MutationTransaction {
            transaction_id: transaction_id.clone(),
            request_id: request.request_id,
            node_id: request.node_id,
            relative_path: node.relative_path.clone(),
            before_hash: hash(&before),
            after_hash: hash(&request.replacement),
            bytes_written: request.replacement.len(),
            diff_summary: summarize_line_diff(&before, &request.replacement),
            created_at: Utc::now(),
            recovery_expires_at: Utc::now() + self.retention,
            recovery_path: recovery_path.clone(),
        };
        if self.write_journal(&transaction).is_err() {
            let _ = fs::remove_file(&recovery_path);
            return Err(MutationError::Io);
        }
        let temp = temp_path_for(&target)?;
        if write_new_file(&temp, request.replacement.as_bytes()).is_err() {
            let _ = fs::remove_file(&recovery_path);
            let _ = fs::remove_file(self.journal_path(&transaction_id));
            return Err(MutationError::Io);
        }
        if atomic_replace(&temp, &target).is_err() {
            let _ = fs::remove_file(&temp);
            let _ = fs::remove_file(&recovery_path);
            let _ = fs::remove_file(self.journal_path(&transaction_id));
            return Err(MutationError::Io);
        }
        self.transactions
            .insert(transaction.transaction_id.clone(), transaction.clone());
        Ok(transaction)
    }

    pub fn revert(
        &mut self,
        transaction_id: &str,
        current_hash: &str,
    ) -> Result<MutationTransaction, MutationError> {
        self.ensure_storage()?;
        self.prune();
        let transaction = self
            .transactions
            .get(transaction_id)
            .cloned()
            .ok_or(MutationError::RecoveryUnavailable)?;
        if transaction.after_hash != current_hash {
            return Err(MutationError::Conflict);
        }
        let target = resolve_relative(self.workspace.root(), &transaction.relative_path)
            .map_err(|_| MutationError::TargetDenied)?;
        let current = fs::read_to_string(&target).map_err(|_| MutationError::Conflict)?;
        if hash(&current) != transaction.after_hash {
            return Err(MutationError::Conflict);
        }
        let recovery =
            fs::read(&transaction.recovery_path).map_err(|_| MutationError::RecoveryUnavailable)?;
        let temp = temp_path_for(&target)?;
        write_new_file(&temp, &recovery).map_err(|_| MutationError::Io)?;
        atomic_replace(&temp, &target).map_err(|_| MutationError::Io)?;
        self.transactions.remove(transaction_id);
        let _ = fs::remove_file(&transaction.recovery_path);
        let _ = fs::remove_file(self.journal_path(transaction_id));
        Ok(transaction)
    }

    pub fn transaction(&self, transaction_id: &str) -> Option<&MutationTransaction> {
        self.transactions.get(transaction_id)
    }

    fn recovery_directory(&self) -> Result<PathBuf, MutationError> {
        let directory = self
            .workspace
            .root()
            .join(".vectant-local-support")
            .join("recovery");
        fs::create_dir_all(&directory).map_err(|_| MutationError::Io)?;
        restrict_directory_permissions(&directory).map_err(|_| MutationError::Io)?;
        Ok(directory)
    }

    fn recovery_path(&self, transaction_id: &str) -> Result<PathBuf, MutationError> {
        Ok(self
            .recovery_directory()?
            .join(format!("{transaction_id}.bak")))
    }

    fn journal_path(&self, transaction_id: &str) -> PathBuf {
        self.workspace
            .root()
            .join(".vectant-local-support")
            .join("recovery")
            .join(format!("{transaction_id}.json"))
    }

    fn write_journal(&self, transaction: &MutationTransaction) -> std::io::Result<()> {
        let journal = MutationJournal {
            transaction: transaction.clone(),
            recovery_file: format!("{}.bak", transaction.transaction_id),
        };
        let encoded = serde_json::to_vec(&journal)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        write_new_file(&self.journal_path(&transaction.transaction_id), &encoded)
    }

    fn load_recovery_journals(&mut self) {
        let Ok(directory) = self.recovery_directory() else {
            self.storage_error = true;
            return;
        };
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                self.storage_error = true;
                return;
            }
        };
        let mut journal_count = 0usize;
        for entry in entries {
            let Ok(entry) = entry else {
                self.storage_error = true;
                return;
            };
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            journal_count += 1;
            if journal_count > MAX_MUTATION_TRANSACTIONS
                || fs::metadata(&path)
                    .map(|metadata| metadata.len() > MAX_JOURNAL_BYTES)
                    .unwrap_or(true)
            {
                self.storage_error = true;
                return;
            }
            let journal: MutationJournal = match fs::read(&path)
                .ok()
                .and_then(|contents| serde_json::from_slice(&contents).ok())
            {
                Some(journal) => journal,
                None => {
                    self.storage_error = true;
                    return;
                }
            };
            let expected_filename = format!("{}.json", journal.transaction.transaction_id);
            if entry.file_name().to_str() != Some(expected_filename.as_str())
                || !valid_journal(&journal, &directory)
            {
                self.storage_error = true;
                return;
            }
            let mut transaction = journal.transaction;
            transaction.recovery_path = directory.join(journal.recovery_file);
            self.transactions
                .insert(transaction.transaction_id.clone(), transaction);
        }
    }

    fn ensure_storage(&self) -> Result<(), MutationError> {
        if self.storage_error {
            Err(MutationError::RecoveryUnavailable)
        } else {
            Ok(())
        }
    }

    fn prune(&mut self) {
        let now = Utc::now();
        let journal_directory = self
            .workspace
            .root()
            .join(".vectant-local-support")
            .join("recovery");
        self.transactions.retain(|_, transaction| {
            if transaction.recovery_expires_at < now {
                let _ = fs::remove_file(&transaction.recovery_path);
                let _ = fs::remove_file(
                    journal_directory.join(format!("{}.json", transaction.transaction_id)),
                );
                false
            } else {
                true
            }
        });
    }
}

fn valid_journal(journal: &MutationJournal, directory: &Path) -> bool {
    let transaction = &journal.transaction;
    safe_id(&transaction.transaction_id)
        && safe_id(&transaction.request_id)
        && safe_id(&transaction.node_id)
        && safe_workspace_relative_path(&transaction.relative_path)
        && journal.recovery_file == format!("{}.bak", transaction.transaction_id)
        && directory.join(&journal.recovery_file).is_file()
}

fn safe_id(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}
fn new_id() -> String {
    let entropy: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    format!("txn_{entropy}")
}
fn hash(value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    format!("sha256:{}", hex::encode(digest.finalize()))
}

fn summarize_line_diff(before: &str, after: &str) -> MutationDiffSummary {
    let before_lines = before.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    let prefix = before_lines
        .iter()
        .zip(&after_lines)
        .take_while(|(left, right)| left == right)
        .count();
    let remaining_before = before_lines.len().saturating_sub(prefix);
    let remaining_after = after_lines.len().saturating_sub(prefix);
    let suffix = before_lines[prefix..]
        .iter()
        .rev()
        .zip(after_lines[prefix..].iter().rev())
        .take(remaining_before.min(remaining_after))
        .take_while(|(left, right)| left == right)
        .count();
    let lines_removed = remaining_before.saturating_sub(suffix);
    let lines_added = remaining_after.saturating_sub(suffix);
    MutationDiffSummary {
        lines_added,
        lines_removed,
        lines_unchanged: prefix + suffix,
        changed: lines_added > 0 || lines_removed > 0,
    }
}

fn write_new_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    restrict_file_permissions(path)?;
    file.write_all(content)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}
#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}
#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
fn temp_path_for(target: &Path) -> Result<PathBuf, MutationError> {
    let parent = target.parent().ok_or(MutationError::TargetDenied)?;
    Ok(parent.join(format!(".vectant-txn-{}.tmp", new_id())))
}
#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_summary_exposes_counts_without_content() {
        let summary =
            summarize_line_diff("same\nSECRET_REMOVED\ntail\n", "same\nSECRET_ADDED\ntail\n");
        assert_eq!(summary.lines_added, 1);
        assert_eq!(summary.lines_removed, 1);
        assert_eq!(summary.lines_unchanged, 2);
        assert!(summary.changed);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(!serialized.contains("SECRET_REMOVED"));
        assert!(!serialized.contains("SECRET_ADDED"));
    }
}
