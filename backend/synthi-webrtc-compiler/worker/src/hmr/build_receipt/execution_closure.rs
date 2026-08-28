use super::{hash_field, prefixed_hash, BuildReceiptError};
use crate::hmr::build_manifest::RELOAD_ARTIFACT_INPUT_ID_PREFIX;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const OBSERVED_EXECUTION_CLOSURE_SCHEMA_VERSION: &str =
    "synthi.observed_execution_closure.v1";
const OBSERVED_EXECUTION_CLOSURE_AUTHORITY: &str =
    "captured_execution_inputs_only_not_closed_execution_or_gpu_hmr_proof";
const OBSERVED_EXECUTION_CLOSURE_ID_PREFIX: &str = "execution-closure:sha256:";
const EXECUTION_NAMESPACE_SEMANTICS: &str = "virtual_posix_case_sensitive_v1";
const DEFAULT_MAX_FILES: usize = 32_768;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_LOGICAL_PATH_BYTES: u64 = 4 * 1024;
const MAX_SOURCE_LOCATOR_BYTES: u64 = 128 * 1024;
const MAX_TOTAL_PATH_METADATA_BYTES: u64 = 32 * 1024 * 1024;
const CAPTURE_BUFFER_BYTES: usize = 64 * 1024;
const PATH_VALIDATION_YIELD_INTERVAL: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionClosureAccessMode {
    ReadOnly,
    Executable,
}

/// Caller-declared transport for one file that a future closed execution may
/// expose. The observer, not the caller, reads and hashes the bytes.
#[derive(Debug, Clone)]
pub(crate) struct DeclaredExecutionFilePlan {
    source_locator: PathBuf,
    logical_path: PathBuf,
    access_mode: ExecutionClosureAccessMode,
}

impl DeclaredExecutionFilePlan {
    pub(crate) fn new(
        source_locator: impl Into<PathBuf>,
        logical_path: impl Into<PathBuf>,
        access_mode: ExecutionClosureAccessMode,
    ) -> Self {
        Self {
            source_locator: source_locator.into(),
            logical_path: logical_path.into(),
            access_mode,
        }
    }
}

/// Identity-free declaration for the complete file namespace intended for a
/// closed build process. Limits are resource controls only and never proof.
#[derive(Debug, Clone)]
pub(crate) struct DeclaredExecutionClosurePlan {
    files: Vec<DeclaredExecutionFilePlan>,
    max_files: usize,
    max_total_bytes: u64,
    max_single_file_bytes: u64,
}

impl DeclaredExecutionClosurePlan {
    pub(crate) fn new(files: Vec<DeclaredExecutionFilePlan>) -> Self {
        Self {
            files,
            max_files: DEFAULT_MAX_FILES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            max_single_file_bytes: DEFAULT_MAX_SINGLE_FILE_BYTES,
        }
    }

    pub(crate) fn limits(
        mut self,
        max_files: usize,
        max_total_bytes: u64,
        max_single_file_bytes: u64,
    ) -> Self {
        self.max_files = max_files;
        self.max_total_bytes = max_total_bytes;
        self.max_single_file_bytes = max_single_file_bytes;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedExecutionClosureFileReceipt {
    input_id: String,
    logical_path: String,
    content_hash: String,
    byte_length: u64,
    access_mode: ExecutionClosureAccessMode,
}

/// A content-addressed snapshot of proposed execution inputs.
///
/// This record proves capture only. It is not evidence that a process was
/// confined to the snapshot and cannot authorize a build or GPU HMR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedExecutionClosureReceipt {
    schema_version: String,
    evidence_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
    binding_id: String,
    observer_id: String,
    clock_id: String,
    challenge_id: String,
    challenge_expires_monotonic_ns: u64,
    invocation_hash: String,
    capture_started_monotonic_ns: u64,
    capture_completed_monotonic_ns: u64,
    namespace_semantics: String,
    closure_id: String,
    file_count: usize,
    total_bytes: u64,
    files: Vec<ObservedExecutionClosureFileReceipt>,
}

impl ObservedExecutionClosureReceipt {
    pub(crate) fn closure_id(&self) -> &str {
        &self.closure_id
    }

    pub(crate) fn evidence_authority(&self) -> &str {
        &self.evidence_authority
    }

    pub(crate) fn invocation_hash(&self) -> &str {
        &self.invocation_hash
    }

    pub(crate) fn is_bound_to_invocation(&self, invocation_hash: &str) -> bool {
        let recomputed_total_bytes = self.files.iter().try_fold(0u64, |total, file| {
            total.checked_add(file.byte_length)
        });
        self.schema_version == OBSERVED_EXECUTION_CLOSURE_SCHEMA_VERSION
            && self.evidence_authority == OBSERVED_EXECUTION_CLOSURE_AUTHORITY
            && !self.accepted_for_gpu_hmr
            && !self.gpu_hmr_success
            && !self.can_satisfy_runtime_proof
            && self.namespace_semantics == EXECUTION_NAMESPACE_SEMANTICS
            && self.file_count == self.files.len()
            && recomputed_total_bytes == Some(self.total_bytes)
            && self.closure_id == derive_closure_id(&self.files, self.total_bytes)
            && self.invocation_hash == invocation_hash
            && self.capture_started_monotonic_ns <= self.capture_completed_monotonic_ns
            && self.capture_completed_monotonic_ns < self.challenge_expires_monotonic_ns
            && self.binding_id
                == derive_binding_id(
                    &self.closure_id,
                    &self.observer_id,
                    &self.clock_id,
                    &self.challenge_id,
                    self.challenge_expires_monotonic_ns,
                    &self.invocation_hash,
                    self.capture_started_monotonic_ns,
                    self.capture_completed_monotonic_ns,
                )
    }

    pub(crate) fn is_bound_to_context(
        &self,
        invocation_hash: &str,
        observer_id: &str,
        clock_id: &str,
        challenge_id: &str,
        challenge_expires_monotonic_ns: u64,
    ) -> bool {
        self.is_bound_to_invocation(invocation_hash)
            && self.observer_id == observer_id
            && self.clock_id == clock_id
            && self.challenge_id == challenge_id
            && self.challenge_expires_monotonic_ns == challenge_expires_monotonic_ns
    }
}

#[derive(Debug, Clone)]
pub(super) struct CapturedExecutionFile {
    pub(super) logical_path: PathBuf,
    pub(super) access_mode: ExecutionClosureAccessMode,
    pub(super) byte_length: u64,
    pub(super) snapshot: Arc<std::fs::File>,
}

#[derive(Debug, Clone)]
pub(super) struct CapturedExecutionClosure {
    closure_id: String,
    total_bytes: u64,
    file_receipts: Vec<ObservedExecutionClosureFileReceipt>,
    files: Vec<CapturedExecutionFile>,
    bound_receipt: Option<ObservedExecutionClosureReceipt>,
}

impl CapturedExecutionClosure {
    pub(super) fn closure_id(&self) -> &str {
        &self.closure_id
    }

    pub(super) fn receipt(&self) -> Option<&ObservedExecutionClosureReceipt> {
        self.bound_receipt.as_ref()
    }

    pub(super) fn files(&self) -> &[CapturedExecutionFile] {
        &self.files
    }

    pub(super) fn bind_to_invocation(
        &mut self,
        observer_id: &str,
        clock_id: &str,
        challenge_id: &str,
        challenge_expires_monotonic_ns: u64,
        invocation_hash: &str,
        capture_started_monotonic_ns: u64,
        capture_completed_monotonic_ns: u64,
    ) -> Result<(), BuildReceiptError> {
        if self.bound_receipt.is_some()
            || capture_started_monotonic_ns > capture_completed_monotonic_ns
            || capture_completed_monotonic_ns >= challenge_expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_execution_closure_invocation_binding_is_invalid",
            ));
        }
        let binding_id = derive_binding_id(
            &self.closure_id,
            observer_id,
            clock_id,
            challenge_id,
            challenge_expires_monotonic_ns,
            invocation_hash,
            capture_started_monotonic_ns,
            capture_completed_monotonic_ns,
        );
        self.bound_receipt = Some(ObservedExecutionClosureReceipt {
            schema_version: OBSERVED_EXECUTION_CLOSURE_SCHEMA_VERSION.to_string(),
            evidence_authority: OBSERVED_EXECUTION_CLOSURE_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
            binding_id,
            observer_id: observer_id.to_string(),
            clock_id: clock_id.to_string(),
            challenge_id: challenge_id.to_string(),
            challenge_expires_monotonic_ns,
            invocation_hash: invocation_hash.to_string(),
            capture_started_monotonic_ns,
            capture_completed_monotonic_ns,
            namespace_semantics: EXECUTION_NAMESPACE_SEMANTICS.to_string(),
            closure_id: self.closure_id.clone(),
            file_count: self.file_receipts.len(),
            total_bytes: self.total_bytes,
            files: self.file_receipts.clone(),
        });
        Ok(())
    }
}

pub(super) async fn capture_execution_closure(
    plan: &DeclaredExecutionClosurePlan,
) -> Result<CapturedExecutionClosure, BuildReceiptError> {
    validate_limits(plan)?;
    let mut observed = Vec::with_capacity(plan.files.len());
    let mut total_bytes = 0u64;
    let mut path_metadata_bytes = 0u64;
    let mut declared_files = Vec::with_capacity(plan.files.len());
    for (index, declared) in plan.files.iter().enumerate() {
        let logical_path_bytes = bounded_path_storage_bytes(
            &declared.logical_path,
            MAX_LOGICAL_PATH_BYTES,
            "build_execution_closure_logical_path_limit_exceeded",
        )?;
        let source_locator_bytes = bounded_path_storage_bytes(
            &declared.source_locator,
            MAX_SOURCE_LOCATOR_BYTES,
            "build_execution_closure_source_locator_limit_exceeded",
        )?;
        path_metadata_bytes = path_metadata_bytes
            .checked_add(logical_path_bytes)
            .and_then(|value| value.checked_add(source_locator_bytes))
            .ok_or_else(|| {
                BuildReceiptError::new("build_execution_closure_path_metadata_bytes_overflow")
            })?;
        if path_metadata_bytes > MAX_TOTAL_PATH_METADATA_BYTES {
            return Err(BuildReceiptError::new(
                "build_execution_closure_path_metadata_limit_exceeded",
            ));
        }
        declared_files.push((
            declared.clone(),
            canonical_logical_path(&declared.logical_path)?,
        ));
        if (index + 1) % PATH_VALIDATION_YIELD_INTERVAL == 0 {
            tokio::task::yield_now().await;
        }
    }
    let declared_files = tokio::task::spawn_blocking(move || {
        declared_files.sort_by(|left, right| left.1.cmp(&right.1));
        validate_logical_namespace(&declared_files)?;
        Ok::<_, BuildReceiptError>(declared_files)
    })
    .await
    .map_err(|_| BuildReceiptError::new("build_execution_closure_namespace_task_failed"))??;

    for (declared, logical_path) in declared_files {
        let remaining_total_bytes = plan
            .max_total_bytes
            .checked_sub(total_bytes)
            .ok_or_else(|| {
                BuildReceiptError::new("build_execution_closure_total_bytes_overflow")
            })?;
        if remaining_total_bytes == 0 {
            return Err(BuildReceiptError::new(
                "build_execution_closure_total_bytes_limit_exceeded",
            ));
        }
        let capture_limit = plan.max_single_file_bytes.min(remaining_total_bytes);
        let limit_reason = if remaining_total_bytes < plan.max_single_file_bytes {
            "build_execution_closure_total_bytes_limit_exceeded"
        } else {
            "build_execution_closure_single_file_limit_exceeded"
        };
        let snapshot = capture_stable_file(&declared, capture_limit, limit_reason).await?;
        total_bytes = total_bytes
            .checked_add(snapshot.byte_length)
            .ok_or_else(|| {
                BuildReceiptError::new("build_execution_closure_total_bytes_overflow")
            })?;
        if total_bytes > plan.max_total_bytes {
            return Err(BuildReceiptError::new(
                "build_execution_closure_total_bytes_limit_exceeded",
            ));
        }
        let content_hash = snapshot.content_hash;
        let input_id = prefixed_hash(
            RELOAD_ARTIFACT_INPUT_ID_PREFIX,
            b"synthi.execution_closure_input.v1",
            &[logical_path.as_bytes(), content_hash.as_bytes()],
        );
        observed.push((
            ObservedExecutionClosureFileReceipt {
                input_id,
                logical_path: logical_path.clone(),
                content_hash,
                byte_length: snapshot.byte_length,
                access_mode: declared.access_mode,
            },
            CapturedExecutionFile {
                logical_path: PathBuf::from(logical_path),
                access_mode: declared.access_mode,
                byte_length: snapshot.byte_length,
                snapshot: snapshot.file,
            },
        ));
    }

    observed.sort_by(|left, right| left.0.logical_path.cmp(&right.0.logical_path));
    let files = observed
        .iter()
        .map(|(receipt, _)| receipt.clone())
        .collect::<Vec<_>>();
    let closure_id = derive_closure_id(&files, total_bytes);
    let captured_files = observed
        .into_iter()
        .map(|(_, captured)| captured)
        .collect();
    Ok(CapturedExecutionClosure {
        closure_id,
        total_bytes,
        file_receipts: files,
        files: captured_files,
        bound_receipt: None,
    })
}

fn validate_logical_namespace(
    declared_files: &[(DeclaredExecutionFilePlan, String)],
) -> Result<(), BuildReceiptError> {
    for adjacent in declared_files.windows(2) {
        if adjacent[0].1 == adjacent[1].1 {
            return Err(BuildReceiptError::new(
                "build_execution_closure_logical_path_is_duplicated",
            ));
        }
        if logical_paths_conflict(&adjacent[0].1, &adjacent[1].1) {
            return Err(BuildReceiptError::new(
                "build_execution_closure_logical_path_namespace_conflict",
            ));
        }
    }
    Ok(())
}

fn logical_paths_conflict(parent_candidate: &str, child_candidate: &str) -> bool {
    child_candidate
        .strip_prefix(parent_candidate)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_limits(plan: &DeclaredExecutionClosurePlan) -> Result<(), BuildReceiptError> {
    if plan.files.is_empty() {
        return Err(BuildReceiptError::new(
            "build_execution_closure_files_are_empty",
        ));
    }
    if plan.max_files == 0
        || plan.max_total_bytes == 0
        || plan.max_single_file_bytes == 0
        || plan.max_single_file_bytes > plan.max_total_bytes
    {
        return Err(BuildReceiptError::new(
            "build_execution_closure_limits_are_invalid",
        ));
    }
    if plan.max_files > DEFAULT_MAX_FILES
        || plan.max_total_bytes > DEFAULT_MAX_TOTAL_BYTES
        || plan.max_single_file_bytes > DEFAULT_MAX_SINGLE_FILE_BYTES
    {
        return Err(BuildReceiptError::new(
            "build_execution_closure_limits_exceed_verifier_policy",
        ));
    }
    if plan.files.len() > plan.max_files {
        return Err(BuildReceiptError::new(
            "build_execution_closure_file_count_limit_exceeded",
        ));
    }
    Ok(())
}

fn bounded_path_storage_bytes(
    path: &Path,
    limit: u64,
    limit_reason: &'static str,
) -> Result<u64, BuildReceiptError> {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::ffi::OsStrExt;
        let byte_length = path.as_os_str().as_bytes().len() as u64;
        return if byte_length <= limit {
            Ok(byte_length)
        } else {
            Err(BuildReceiptError::new(limit_reason))
        };
    }
    #[cfg(target_family = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let max_code_units = limit / 2;
        let code_units = path
            .as_os_str()
            .encode_wide()
            .take(max_code_units.saturating_add(1) as usize)
            .count() as u64;
        return if code_units <= max_code_units {
            Ok(code_units * 2)
        } else {
            Err(BuildReceiptError::new(limit_reason))
        };
    }
    #[cfg(not(any(target_family = "unix", target_family = "windows")))]
    {
        let value = path.as_os_str().to_str().ok_or_else(|| {
            BuildReceiptError::new("build_execution_closure_path_encoding_is_unsupported")
        })?;
        return if value.len() as u64 <= limit {
            Ok(value.len() as u64)
        } else {
            Err(BuildReceiptError::new(limit_reason))
        };
    }
}

fn canonical_logical_path(path: &Path) -> Result<String, BuildReceiptError> {
    if !path.is_absolute() {
        return Err(BuildReceiptError::new(
            "build_execution_closure_logical_path_is_not_absolute",
        ));
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(segment) => {
                let segment = segment.to_str().ok_or_else(|| {
                    BuildReceiptError::new(
                        "build_execution_closure_logical_path_encoding_is_unsupported",
                    )
                })?;
                if segment.is_empty() || segment.contains('\0') {
                    return Err(BuildReceiptError::new(
                        "build_execution_closure_logical_path_is_invalid",
                    ));
                }
                segments.push(segment);
            }
            _ => {
                return Err(BuildReceiptError::new(
                    "build_execution_closure_logical_path_is_not_canonical",
                ));
            }
        }
    }
    if segments.is_empty() {
        return Err(BuildReceiptError::new(
            "build_execution_closure_logical_path_is_not_a_file",
        ));
    }
    Ok(format!("/{}", segments.join("/")))
}

struct StableFileSnapshot {
    content_hash: String,
    byte_length: u64,
    file: Arc<std::fs::File>,
}

async fn capture_stable_file(
    declared: &DeclaredExecutionFilePlan,
    capture_limit_bytes: u64,
    limit_reason: &'static str,
) -> Result<StableFileSnapshot, BuildReceiptError> {
    ensure_stable_capture_capabilities()?;
    if !declared.source_locator.is_absolute() {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_locator_is_not_absolute",
        ));
    }
    let canonical = tokio::fs::canonicalize(&declared.source_locator)
        .await
        .map_err(|_| {
            BuildReceiptError::new("build_execution_closure_source_resolution_failed")
        })?;
    if canonical != declared.source_locator {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_locator_is_not_canonical",
        ));
    }
    let path_before = tokio::fs::symlink_metadata(&declared.source_locator)
        .await
        .map_err(|_| {
            BuildReceiptError::new("build_execution_closure_source_inspection_failed")
        })?;
    if !path_before.file_type().is_file() || path_before.file_type().is_symlink() {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_is_not_regular_file",
        ));
    }
    if path_before.len() > capture_limit_bytes {
        return Err(BuildReceiptError::new(limit_reason));
    }
    validate_executable_mode(&path_before, declared.access_mode)?;

    let mut file = tokio::fs::File::open(&declared.source_locator)
        .await
        .map_err(|_| BuildReceiptError::new("build_execution_closure_source_open_failed"))?;
    let handle_before = file.metadata().await.map_err(|_| {
        BuildReceiptError::new("build_execution_closure_source_handle_inspection_failed")
    })?;
    if !same_file_state(&path_before, &handle_before) {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_path_swap_detected",
        ));
    }

    let anonymous_snapshot = create_sealable_snapshot()?;
    let mut snapshot = tokio::fs::File::from_std(anonymous_snapshot);
    let (first_hash, first_length) = stream_and_hash_file(
        &mut file,
        Some(&mut snapshot),
        capture_limit_bytes,
        limit_reason,
    )
    .await?;
    snapshot.sync_all().await.map_err(|_| {
        BuildReceiptError::new("build_execution_closure_snapshot_sync_failed")
    })?;
    snapshot
        .seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(|_| BuildReceiptError::new("build_execution_closure_snapshot_seek_failed"))?;
    let snapshot = seal_snapshot(snapshot.into_std().await)?;

    let handle_between_reads = file.metadata().await.map_err(|_| {
        BuildReceiptError::new("build_execution_closure_source_handle_recheck_failed")
    })?;
    let path_between_reads = tokio::fs::symlink_metadata(&declared.source_locator)
        .await
        .map_err(|_| {
            BuildReceiptError::new("build_execution_closure_source_path_recheck_failed")
        })?;
    if !path_between_reads.file_type().is_file()
        || path_between_reads.file_type().is_symlink()
        || !same_file_state(&handle_before, &handle_between_reads)
        || !same_file_state(&handle_between_reads, &path_between_reads)
        || handle_between_reads.len() != first_length
    {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_changed_during_capture",
        ));
    }

    let (second_hash, second_length) =
        stream_and_hash_file(&mut file, None, capture_limit_bytes, limit_reason).await?;
    let handle_after = file.metadata().await.map_err(|_| {
        BuildReceiptError::new("build_execution_closure_source_handle_recheck_failed")
    })?;
    let path_after = tokio::fs::symlink_metadata(&declared.source_locator)
        .await
        .map_err(|_| {
            BuildReceiptError::new("build_execution_closure_source_path_recheck_failed")
        })?;
    if !repeated_capture_matches(&first_hash, first_length, &second_hash, second_length)
        || !path_after.file_type().is_file()
        || path_after.file_type().is_symlink()
        || !same_file_state(&handle_between_reads, &handle_after)
        || !same_file_state(&handle_after, &path_after)
        || handle_after.len() != second_length
    {
        return Err(BuildReceiptError::new(
            "build_execution_closure_source_changed_during_capture",
        ));
    }

    Ok(StableFileSnapshot {
        content_hash: first_hash,
        byte_length: first_length,
        file: Arc::new(snapshot),
    })
}

fn ensure_stable_capture_capabilities() -> Result<(), BuildReceiptError> {
    #[cfg(target_os = "linux")]
    {
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(BuildReceiptError::new(
            "build_execution_closure_stable_snapshot_capability_unavailable",
        ))
    }
}

#[cfg(target_os = "linux")]
fn create_sealable_snapshot() -> Result<std::fs::File, BuildReceiptError> {
    use std::os::fd::{FromRawFd, RawFd};

    let name = b"synthi-build-execution-closure\0";
    let raw_fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr().cast::<libc::c_char>(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if raw_fd < 0 || raw_fd > RawFd::MAX as libc::c_long {
        return Err(BuildReceiptError::new(
            "build_execution_closure_immutable_snapshot_unavailable",
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(raw_fd as RawFd) })
}

#[cfg(not(target_os = "linux"))]
fn create_sealable_snapshot() -> Result<std::fs::File, BuildReceiptError> {
    Err(BuildReceiptError::new(
        "build_execution_closure_immutable_snapshot_unavailable",
    ))
}

#[cfg(target_os = "linux")]
fn seal_snapshot(snapshot: std::fs::File) -> Result<std::fs::File, BuildReceiptError> {
    use std::os::fd::AsRawFd;

    let raw_fd = snapshot.as_raw_fd();
    if unsafe { libc::fchmod(raw_fd, 0o400) } != 0 {
        return Err(BuildReceiptError::new(
            "build_execution_closure_snapshot_permission_failed",
        ));
    }
    let required_seals =
        libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(raw_fd, libc::F_ADD_SEALS, required_seals) } != 0 {
        return Err(BuildReceiptError::new(
            "build_execution_closure_snapshot_seal_failed",
        ));
    }
    let observed_seals = unsafe { libc::fcntl(raw_fd, libc::F_GET_SEALS) };
    if observed_seals < 0 || observed_seals & required_seals != required_seals {
        return Err(BuildReceiptError::new(
            "build_execution_closure_snapshot_seals_missing",
        ));
    }
    Ok(snapshot)
}

#[cfg(not(target_os = "linux"))]
fn seal_snapshot(_snapshot: std::fs::File) -> Result<std::fs::File, BuildReceiptError> {
    Err(BuildReceiptError::new(
        "build_execution_closure_immutable_snapshot_unavailable",
    ))
}

fn repeated_capture_matches(
    first_hash: &str,
    first_length: u64,
    second_hash: &str,
    second_length: u64,
) -> bool {
    first_hash == second_hash && first_length == second_length
}

async fn stream_and_hash_file(
    source: &mut tokio::fs::File,
    mut snapshot: Option<&mut tokio::fs::File>,
    capture_limit_bytes: u64,
    limit_reason: &'static str,
) -> Result<(String, u64), BuildReceiptError> {
    source
        .seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(|_| BuildReceiptError::new("build_execution_closure_source_seek_failed"))?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0u64;
    let mut buffer = vec![0u8; CAPTURE_BUFFER_BYTES];
    loop {
        let read = source
            .read(&mut buffer)
            .await
            .map_err(|_| BuildReceiptError::new("build_execution_closure_source_read_failed"))?;
        if read == 0 {
            break;
        }
        byte_length = byte_length.checked_add(read as u64).ok_or_else(|| {
            BuildReceiptError::new("build_execution_closure_single_file_bytes_overflow")
        })?;
        if byte_length > capture_limit_bytes {
            return Err(BuildReceiptError::new(limit_reason));
        }
        hasher.update(&buffer[..read]);
        if let Some(destination) = snapshot.as_mut() {
            destination.write_all(&buffer[..read]).await.map_err(|_| {
                BuildReceiptError::new("build_execution_closure_snapshot_write_failed")
            })?;
        }
    }
    Ok((format!("sha256:{:x}", hasher.finalize()), byte_length))
}

fn validate_executable_mode(
    metadata: &std::fs::Metadata,
    access_mode: ExecutionClosureAccessMode,
) -> Result<(), BuildReceiptError> {
    #[cfg(target_family = "unix")]
    if access_mode == ExecutionClosureAccessMode::Executable {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(BuildReceiptError::new(
                "build_execution_closure_executable_permission_missing",
            ));
        }
    }
    #[cfg(not(target_family = "unix"))]
    let _ = (metadata, access_mode);
    Ok(())
}

fn derive_closure_id(
    files: &[ObservedExecutionClosureFileReceipt],
    total_bytes: u64,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        OBSERVED_EXECUTION_CLOSURE_SCHEMA_VERSION.as_bytes(),
    );
    hash_field(
        &mut hasher,
        OBSERVED_EXECUTION_CLOSURE_AUTHORITY.as_bytes(),
    );
    hash_field(&mut hasher, EXECUTION_NAMESPACE_SEMANTICS.as_bytes());
    hasher.update((files.len() as u64).to_be_bytes());
    hasher.update(total_bytes.to_be_bytes());
    for file in files {
        hash_field(&mut hasher, file.input_id.as_bytes());
        hash_field(&mut hasher, file.logical_path.as_bytes());
        hash_field(&mut hasher, file.content_hash.as_bytes());
        hasher.update(file.byte_length.to_be_bytes());
        hash_field(
            &mut hasher,
            match file.access_mode {
                ExecutionClosureAccessMode::ReadOnly => b"read_only",
                ExecutionClosureAccessMode::Executable => b"executable",
            },
        );
    }
    format!(
        "{OBSERVED_EXECUTION_CLOSURE_ID_PREFIX}{:x}",
        hasher.finalize()
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_binding_id(
    closure_id: &str,
    observer_id: &str,
    clock_id: &str,
    challenge_id: &str,
    challenge_expires_monotonic_ns: u64,
    invocation_hash: &str,
    capture_started_monotonic_ns: u64,
    capture_completed_monotonic_ns: u64,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        b"synthi.observed_execution_closure_invocation_binding.v1",
    );
    for field in [
        closure_id,
        observer_id,
        clock_id,
        challenge_id,
        invocation_hash,
    ] {
        hash_field(&mut hasher, field.as_bytes());
    }
    hasher.update(challenge_expires_monotonic_ns.to_be_bytes());
    hasher.update(capture_started_monotonic_ns.to_be_bytes());
    hasher.update(capture_completed_monotonic_ns.to_be_bytes());
    format!("execution-closure-binding:sha256:{:x}", hasher.finalize())
}

fn same_file_state(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.len() == right.len()
            && left.mode() == right.mode()
            && left.uid() == right.uid()
            && left.gid() == right.gid()
            && left.mtime() == right.mtime()
            && left.mtime_nsec() == right.mtime_nsec()
            && left.ctime() == right.ctime()
            && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(not(target_family = "unix"))]
    {
        let _ = (left, right);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::Permissions;
    use std::io::{Read, Seek, Write};

    #[cfg(target_family = "unix")]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(target_family = "unix")]
    fn write_file(path: &Path, bytes: &[u8], mode: u32) {
        std::fs::write(path, bytes).unwrap();
        std::fs::set_permissions(path, Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(target_family = "unix")]
    #[tokio::test]
    async fn captures_canonical_content_bound_file_set_without_authority() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        write_file(&first, b"first-bytes", 0o444);
        write_file(&second, b"second-bytes", 0o555);
        let first = std::fs::canonicalize(first).unwrap();
        let second = std::fs::canonicalize(second).unwrap();
        let plan = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                second,
                "/runtime/tool",
                ExecutionClosureAccessMode::Executable,
            ),
            DeclaredExecutionFilePlan::new(
                first,
                "/workspace/input",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ]);

        let mut captured = capture_execution_closure(&plan).await.unwrap();
        assert_eq!(captured.files().len(), 2);
        assert_eq!(
            captured.files()[0].logical_path,
            PathBuf::from("/runtime/tool")
        );
        assert_eq!(
            captured.files()[0].access_mode,
            ExecutionClosureAccessMode::Executable
        );
        assert_eq!(captured.files()[0].byte_length, 12);
        let mut snapshot = captured.files()[0].snapshot.try_clone().unwrap();
        snapshot.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut snapshot_bytes = Vec::new();
        snapshot.read_to_end(&mut snapshot_bytes).unwrap();
        assert_eq!(snapshot_bytes, b"second-bytes");
        assert!(snapshot.write_all(b"mutation").is_err());
        let closure_id = captured.closure_id().to_string();
        captured
            .bind_to_invocation(
                "observer:sha256:test",
                "clock:sha256:test",
                "challenge:sha256:test",
                3,
                "sha256:invocation",
                1,
                2,
            )
            .unwrap();
        let receipt = serde_json::to_value(captured.receipt().unwrap()).unwrap();
        assert_eq!(
            receipt["evidenceAuthority"],
            OBSERVED_EXECUTION_CLOSURE_AUTHORITY
        );
        assert_eq!(receipt["acceptedForGpuHmr"], false);
        assert_eq!(receipt["gpuHmrSuccess"], false);
        assert_eq!(receipt["canSatisfyRuntimeProof"], false);
        assert_eq!(receipt["invocationHash"], "sha256:invocation");
        assert_eq!(
            receipt["namespaceSemantics"],
            "virtual_posix_case_sensitive_v1"
        );
        assert_eq!(receipt["fileCount"], 2);
        assert_eq!(receipt["files"][0]["logicalPath"], "/runtime/tool");
        assert_eq!(receipt["files"][1]["logicalPath"], "/workspace/input");
        assert!(closure_id.starts_with(OBSERVED_EXECUTION_CLOSURE_ID_PREFIX));
        assert!(receipt["bindingId"]
            .as_str()
            .unwrap()
            .starts_with("execution-closure-binding:sha256:"));
        let mut replayed = captured.receipt().unwrap().clone();
        replayed.invocation_hash = "sha256:other-invocation".to_string();
        assert!(!replayed.is_bound_to_invocation("sha256:other-invocation"));
        assert!(!logical_paths_conflict(
            "/Runtime/tool",
            "/runtime/tool"
        ));
    }

    #[cfg(target_family = "unix")]
    #[tokio::test]
    async fn rejects_aliases_duplicates_permissions_and_resource_overflow() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        write_file(&source, b"bytes", 0o444);
        let canonical = std::fs::canonicalize(&source).unwrap();

        let duplicate = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                canonical.clone(),
                "/same",
                ExecutionClosureAccessMode::ReadOnly,
            ),
            DeclaredExecutionFilePlan::new(
                canonical.clone(),
                "/same",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ]);
        assert_eq!(
            capture_execution_closure(&duplicate)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_logical_path_is_duplicated"
        );

        let namespace_conflict = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                canonical.clone(),
                "/root",
                ExecutionClosureAccessMode::ReadOnly,
            ),
            DeclaredExecutionFilePlan::new(
                canonical.clone(),
                "/root/child",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ]);
        assert_eq!(
            capture_execution_closure(&namespace_conflict)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_logical_path_namespace_conflict"
        );

        let alias = root.path().join("source-alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        let noncanonical = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                alias,
                "/input",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ]);
        assert_eq!(
            capture_execution_closure(&noncanonical)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_source_locator_is_not_canonical"
        );

        let executable = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                canonical.clone(),
                "/tool",
                ExecutionClosureAccessMode::Executable,
            ),
        ]);
        assert_eq!(
            capture_execution_closure(&executable)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_executable_permission_missing"
        );

        let overflow = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                canonical,
                "/input",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ])
        .limits(1, 4, 4);
        assert_eq!(
            capture_execution_closure(&overflow)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_single_file_limit_exceeded"
        );

        let inflated_limits = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                std::fs::canonicalize(&source).unwrap(),
                "/input",
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ])
        .limits(usize::MAX, u64::MAX, u64::MAX);
        assert_eq!(
            capture_execution_closure(&inflated_limits)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_limits_exceed_verifier_policy"
        );

        let oversized_logical_path = DeclaredExecutionClosurePlan::new(vec![
            DeclaredExecutionFilePlan::new(
                std::fs::canonicalize(&source).unwrap(),
                format!("/{}", "x".repeat(MAX_LOGICAL_PATH_BYTES as usize)),
                ExecutionClosureAccessMode::ReadOnly,
            ),
        ]);
        assert_eq!(
            capture_execution_closure(&oversized_logical_path)
                .await
                .unwrap_err()
                .to_string(),
            "build_execution_closure_logical_path_limit_exceeded"
        );

        assert!(!repeated_capture_matches(
            "sha256:first",
            5,
            "sha256:second",
            5
        ));
    }
}
