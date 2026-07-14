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
    pub created_at: DateTime<Utc>,
    pub recovery_expires_at: DateTime<Utc>,
    #[serde(skip)]
    recovery_path: PathBuf,
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
}

impl WorkspaceMutationBroker {
    pub fn new(workspace: WorkspacePolicy, retention: Duration) -> Self {
        Self {
            workspace,
            scanner: SecretScanner::default(),
            retention,
            transactions: HashMap::new(),
        }
    }

    pub fn apply(
        &mut self,
        graph: &HashMap<String, GraphNode>,
        request: MutationRequest,
    ) -> Result<MutationTransaction, MutationError> {
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
        let recovery_path = self.recovery_path()?;
        write_new_file(&recovery_path, before.as_bytes()).map_err(|_| MutationError::Io)?;
        let temp = temp_path_for(&target)?;
        if write_new_file(&temp, request.replacement.as_bytes()).is_err() {
            let _ = fs::remove_file(&recovery_path);
            return Err(MutationError::Io);
        }
        if atomic_replace(&temp, &target).is_err() {
            let _ = fs::remove_file(&temp);
            let _ = fs::remove_file(&recovery_path);
            return Err(MutationError::Io);
        }
        let transaction = MutationTransaction {
            transaction_id: new_id(),
            request_id: request.request_id,
            node_id: request.node_id,
            relative_path: node.relative_path.clone(),
            before_hash: hash(&before),
            after_hash: hash(&request.replacement),
            bytes_written: request.replacement.len(),
            created_at: Utc::now(),
            recovery_expires_at: Utc::now() + self.retention,
            recovery_path,
        };
        self.transactions
            .insert(transaction.transaction_id.clone(), transaction.clone());
        Ok(transaction)
    }

    pub fn revert(
        &mut self,
        transaction_id: &str,
        current_hash: &str,
    ) -> Result<MutationTransaction, MutationError> {
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
        Ok(transaction)
    }

    pub fn transaction(&self, transaction_id: &str) -> Option<&MutationTransaction> {
        self.transactions.get(transaction_id)
    }

    fn recovery_path(&self) -> Result<PathBuf, MutationError> {
        let directory = self
            .workspace
            .root()
            .join(".vectant-local-support")
            .join("recovery");
        fs::create_dir_all(&directory).map_err(|_| MutationError::Io)?;
        Ok(directory.join(format!("{}.bak", new_id())))
    }
    fn prune(&mut self) {
        let now = Utc::now();
        self.transactions.retain(|_, transaction| {
            if transaction.recovery_expires_at < now {
                let _ = fs::remove_file(&transaction.recovery_path);
                false
            } else {
                true
            }
        });
    }
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
fn write_new_file(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(content)?;
    file.sync_all()?;
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
