use super::*;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::time::{timeout_at, Instant as TokioInstant};

const DEFAULT_STDOUT_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
const EXECUTABLE_BINDING: &str = "sealed_immutable_executable_snapshot_v1";
const EXECUTION_BOUNDARY: &str =
    "sealed_snapshot_seccomp_lineage_process_group_and_consumed_stdin_v1";

/// Declarative intent for one observer-owned process whose exact input is
/// delivered through stdin and whose artifact bytes are captured from stdout.
///
/// The plan cannot carry process status, timings, hashes, or output bytes.
/// Those values are measured by `BuildReceiptVerifier` around the process it
/// constructs and executes itself.
#[derive(Debug, Clone)]
pub(crate) struct StdinStdoutBuildStepPlan {
    executable_locator: PathBuf,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    inherit_parent_environment: bool,
    input_id: String,
    input_bytes: Arc<[u8]>,
    output_ordinal: u32,
    timeout: Duration,
    stdout_limit_bytes: u64,
    stderr_limit_bytes: u64,
}

impl StdinStdoutBuildStepPlan {
    pub(crate) fn new(
        executable_locator: impl Into<PathBuf>,
        input_id: impl Into<String>,
        input_bytes: Arc<[u8]>,
        output_ordinal: u32,
    ) -> Result<Self, BuildReceiptError> {
        let input_id = input_id.into();
        validate_prefixed_hash(
            &input_id,
            RELOAD_ARTIFACT_INPUT_ID_PREFIX,
            "build_observer_input_id_is_invalid",
        )?;
        if input_bytes.is_empty() {
            return Err(BuildReceiptError::new(
                "build_observer_input_bytes_are_empty",
            ));
        }
        Ok(Self {
            executable_locator: executable_locator.into(),
            arguments: Vec::new(),
            environment: BTreeMap::new(),
            inherit_parent_environment: false,
            input_id,
            input_bytes,
            output_ordinal,
            timeout: Duration::from_secs(120),
            stdout_limit_bytes: DEFAULT_STDOUT_LIMIT_BYTES,
            stderr_limit_bytes: DEFAULT_STDERR_LIMIT_BYTES,
        })
    }

    pub(crate) fn arg(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    pub(crate) fn args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.arguments
            .extend(arguments.into_iter().map(Into::into));
        self
    }

    pub(crate) fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment.insert(key.into(), value.into());
        self
    }

    pub(crate) fn inherit_parent_environment(mut self, inherit: bool) -> Self {
        self.inherit_parent_environment = inherit;
        self
    }

    pub(crate) fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub(crate) fn output_limits(mut self, stdout_bytes: u64, stderr_bytes: u64) -> Self {
        self.stdout_limit_bytes = stdout_bytes;
        self.stderr_limit_bytes = stderr_bytes;
        self
    }

}

#[derive(Debug)]
pub(crate) struct ObservedBuildCommandOutcome {
    status: ExitStatus,
    stdout: Arc<[u8]>,
    stderr: Arc<[u8]>,
    receipt: Option<ObservedBuildStepReceipt>,
    started_monotonic_ns: u64,
    completed_monotonic_ns: u64,
}

impl ObservedBuildCommandOutcome {
    pub(crate) fn succeeded(&self) -> bool {
        self.status.success()
    }

    pub(crate) fn exit_code(&self) -> Option<i32> {
        self.status.code()
    }

    pub(crate) fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub(crate) fn stderr(&self) -> &[u8] {
        &self.stderr
    }

    pub(crate) fn receipt(&self) -> Option<&ObservedBuildStepReceipt> {
        self.receipt.as_ref()
    }

    pub(crate) fn monotonic_interval_ns(&self) -> (u64, u64) {
        (self.started_monotonic_ns, self.completed_monotonic_ns)
    }
}

impl BuildReceiptVerifier {
    pub(crate) async fn observe_stdin_stdout_step(
        &mut self,
        challenge: &BuildTransactionChallenge,
        plan: StdinStdoutBuildStepPlan,
    ) -> Result<ObservedBuildCommandOutcome, BuildReceiptError> {
        self.validate_observation_challenge(challenge)?;
        validate_plan(&plan)?;

        let pinned = PinnedExecutable::open(&plan.executable_locator).await?;
        pinned.verify().await?;
        let environment = final_environment(&plan);
        validate_environment(&environment)?;
        let invocation_hash = derive_observed_invocation_hash(&pinned, &plan, &environment);
        let working_directory = tempfile::tempdir()
            .map_err(|_| BuildReceiptError::new("build_observer_working_directory_unavailable"))?;
        let mut observed_stdin = ObservedStdinPipe::new()?;

        let mut command = tokio::process::Command::new(&pinned.launch_path);
        configure_process_boundary(&mut command)?;
        command
            .args(&plan.arguments)
            .env_clear()
            .envs(environment.iter())
            .current_dir(working_directory.path())
            .stdin(observed_stdin.take_child_stdio()?)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let deadline = TokioInstant::now()
            .checked_add(plan.timeout)
            .ok_or_else(|| BuildReceiptError::new("build_observer_timeout_is_invalid"))?;
        let started_monotonic_ns = self.monotonic_now_ns();
        let mut child = command
            .spawn()
            .map_err(|_| BuildReceiptError::new("build_observer_process_spawn_failed"))?;
        let boundary = match ProcessBoundary::attach(&child) {
            Ok(boundary) => boundary,
            Err(error) => {
                terminate_untracked_process(&mut child).await;
                return Err(error);
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                terminate_process_boundary(&mut child, &boundary).await?;
                return Err(BuildReceiptError::new(
                    "build_observer_stdout_pipe_missing",
                ));
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                terminate_process_boundary(&mut child, &boundary).await?;
                return Err(BuildReceiptError::new(
                    "build_observer_stderr_pipe_missing",
                ));
            }
        };
        let mut stdin = match observed_stdin.take_writer() {
            Ok(stdin) => stdin,
            Err(error) => {
                terminate_process_boundary(&mut child, &boundary).await?;
                return Err(error);
            }
        };
        let audit_reader = match observed_stdin.take_audit_reader() {
            Ok(audit_reader) => audit_reader,
            Err(error) => {
                terminate_process_boundary(&mut child, &boundary).await?;
                return Err(error);
            }
        };

        let input_bytes = plan.input_bytes.clone();
        let mut stdin_task = tokio::spawn(async move {
            stdin.write_all(&input_bytes).await?;
            stdin.shutdown().await
        });
        let stdout_limit = plan.stdout_limit_bytes;
        let stderr_limit = plan.stderr_limit_bytes;
        let mut stdout_task = tokio::spawn(async move {
            read_bounded_stream(
                stdout,
                stdout_limit,
                "build_observer_stdout_limit_exceeded",
                "build_observer_stdout_read_failed",
            )
            .await
        });
        let mut stderr_task = tokio::spawn(async move {
            read_bounded_stream(
                stderr,
                stderr_limit,
                "build_observer_stderr_limit_exceeded",
                "build_observer_stderr_read_failed",
            )
            .await
        });

        if let Err(error) = boundary.wait_for_leader_exit(deadline).await {
            terminate_boundary_and_abort_io(
                &mut child,
                &boundary,
                &mut stdin_task,
                &mut stdout_task,
                &mut stderr_task,
            )
            .await?;
            return Err(error);
        }

        let stdin_result = match timeout_at(deadline, &mut stdin_task).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_stdin_task_failed"));
            }
            Err(_) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_command_timed_out"));
            }
        };
        let stdout_result = match timeout_at(deadline, &mut stdout_task).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_stdout_task_failed"));
            }
            Err(_) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_command_timed_out"));
            }
        };
        let stdout = match stdout_result {
            Ok(stdout) => stdout,
            Err(error) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(error);
            }
        };
        let stderr_result = match timeout_at(deadline, &mut stderr_task).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_stderr_task_failed"));
            }
            Err(_) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new("build_observer_command_timed_out"));
            }
        };
        let stderr = match stderr_result {
            Ok(stderr) => stderr,
            Err(error) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(error);
            }
        };
        match boundary.is_quiescent() {
            Ok(true) => {}
            Ok(false) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(BuildReceiptError::new(
                    "build_observer_process_boundary_did_not_quiesce",
                ));
            }
            Err(error) => {
                terminate_boundary_and_abort_io(
                    &mut child,
                    &boundary,
                    &mut stdin_task,
                    &mut stdout_task,
                    &mut stderr_task,
                )
                .await?;
                return Err(error);
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|_| BuildReceiptError::new("build_observer_process_wait_failed"))?;
        if status.success() && stdin_result.is_err() {
            return Err(BuildReceiptError::new(
                "build_observer_stdin_delivery_failed",
            ));
        }
        pinned.verify().await?;
        let completed_monotonic_ns = self.monotonic_now_ns();
        let stdout = Arc::<[u8]>::from(stdout);
        let stderr = Arc::<[u8]>::from(stderr);

        if !status.success() {
            return Ok(ObservedBuildCommandOutcome {
                status,
                stdout,
                stderr,
                receipt: None,
                started_monotonic_ns,
                completed_monotonic_ns,
            });
        }
        let unconsumed_input = timeout_at(
            deadline,
            read_bounded_stream(
                audit_reader,
                plan.input_bytes.len() as u64,
                "build_observer_input_audit_limit_exceeded",
                "build_observer_input_audit_failed",
            ),
        )
        .await
        .map_err(|_| BuildReceiptError::new("build_observer_command_timed_out"))??;
        if !unconsumed_input.is_empty() {
            return Err(BuildReceiptError::new(
                "build_observer_input_was_not_fully_consumed",
            ));
        }
        if stdout.is_empty() {
            return Err(BuildReceiptError::new(
                "build_observer_required_output_is_empty",
            ));
        }

        let input = ObservedBuildInputReceipt {
            input_id: plan.input_id.clone(),
            content_hash: content_hash(&plan.input_bytes),
            byte_length: plan.input_bytes.len() as u64,
            consumption_proof: OBSERVED_BUILD_INPUT_CONSUMPTION_PROOF.to_string(),
        };
        let output = ObservedBuildOutputReceipt {
            output_ordinal: plan.output_ordinal,
            consumed_input_ids: vec![plan.input_id.clone()],
            consumed_upstream_outputs: Vec::new(),
            content_hash: content_hash(&stdout),
            byte_length: stdout.len() as u64,
        };
        let mut receipt = ObservedBuildStepReceipt {
            schema_version: OBSERVED_BUILD_STEP_RECEIPT_SCHEMA_VERSION.to_string(),
            evidence_authority: OBSERVED_BUILD_STEP_RECEIPT_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
            can_satisfy_build_transaction: false,
            input_transport_bound_to_execution_boundary: false,
            execution_policy_authorized: false,
            execution_runtime_closure_observed: false,
            observer_id: challenge.observer_id.clone(),
            clock_id: challenge.clock_id.clone(),
            challenge_id: challenge.challenge_id.clone(),
            transaction_context_hash: challenge.transaction_context_hash.clone(),
            receipt_id: String::new(),
            executor_hash: pinned.executable_hash.clone(),
            execution_boundary: EXECUTION_BOUNDARY.to_string(),
            invocation_hash,
            started_monotonic_ns,
            completed_monotonic_ns,
            inputs: vec![input],
            outputs: vec![output],
        };
        receipt.receipt_id = derive_step_receipt_id(&receipt);
        self.register_observed_receipt(challenge, &receipt)?;

        Ok(ObservedBuildCommandOutcome {
            status,
            stdout,
            stderr,
            receipt: Some(receipt),
            started_monotonic_ns,
            completed_monotonic_ns,
        })
    }

    fn validate_observation_challenge(
        &self,
        challenge: &BuildTransactionChallenge,
    ) -> Result<(), BuildReceiptError> {
        let active = self
            .active_challenges
            .get(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        if challenge.observer_id != self.observer_id
            || challenge.clock_id != self.clock_id
            || challenge.observer_id != active.observer_id
            || challenge.clock_id != active.clock_id
            || challenge.transaction_context_hash != active.transaction_context_hash
            || challenge.issued_monotonic_ns != active.issued_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_transaction_challenge_observer_binding_mismatch",
            ));
        }
        Ok(())
    }
}

struct PinnedExecutable {
    launch_path: PathBuf,
    handle: tokio::fs::File,
    executable_hash: String,
    executable_bytes: u64,
    binding: &'static str,
}

impl PinnedExecutable {
    async fn open(locator: &Path) -> Result<Self, BuildReceiptError> {
        if !locator.is_absolute() {
            return Err(BuildReceiptError::new(
                "build_observer_executor_locator_is_not_absolute",
            ));
        }
        let canonical_path = tokio::fs::canonicalize(locator)
            .await
            .map_err(|_| BuildReceiptError::new("build_observer_executor_resolution_failed"))?;
        let path_identity = tokio::fs::symlink_metadata(&canonical_path)
            .await
            .map_err(|_| BuildReceiptError::new("build_observer_executor_inspection_failed"))?;
        if !path_identity.file_type().is_file() || path_identity.file_type().is_symlink() {
            return Err(BuildReceiptError::new(
                "build_observer_executor_is_not_regular_file",
            ));
        }
        let handle = tokio::fs::File::open(&canonical_path)
            .await
            .map_err(|_| BuildReceiptError::new("build_observer_executor_open_failed"))?;
        let file_identity = handle
            .metadata()
            .await
            .map_err(|_| BuildReceiptError::new("build_observer_executor_handle_inspection_failed"))?;
        if !same_file_identity(&path_identity, &file_identity) {
            return Err(BuildReceiptError::new(
                "build_observer_executor_path_swap_detected",
            ));
        }
        let bytes = read_held_file(&handle).await?;
        if bytes.is_empty() {
            return Err(BuildReceiptError::new(
                "build_observer_executor_bytes_are_empty",
            ));
        }
        let executable_hash = content_hash(&bytes);
        let executable_bytes = bytes.len() as u64;

        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let snapshot = create_sealed_executable_snapshot(&bytes)?;
            let handle = tokio::fs::File::from_std(snapshot);
            let launch_path = PathBuf::from(format!(
                "/proc/{}/fd/{}",
                std::process::id(),
                handle.as_raw_fd()
            ));
            if tokio::fs::metadata(&launch_path).await.is_err() {
                return Err(BuildReceiptError::new(
                    "build_observer_descriptor_bound_launch_unavailable",
                ));
            }
            return Ok(Self {
                launch_path,
                handle,
                executable_hash,
                executable_bytes,
                binding: EXECUTABLE_BINDING,
            });
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(BuildReceiptError::new(
                "build_observer_immutable_executor_snapshot_unavailable",
            ))
        }
    }

    async fn verify(&self) -> Result<(), BuildReceiptError> {
        let bytes = read_held_file(&self.handle).await?;
        if bytes.len() as u64 != self.executable_bytes
            || content_hash(&bytes) != self.executable_hash
        {
            return Err(BuildReceiptError::new(
                "build_observer_executor_bytes_changed",
            ));
        }
        verify_executable_snapshot_seals(&self.handle)?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn create_sealed_executable_snapshot(
    bytes: &[u8],
) -> Result<std::fs::File, BuildReceiptError> {
    use std::os::fd::{FromRawFd, RawFd};

    let name = b"synthi-build-observer\0";
    let raw_fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr().cast::<libc::c_char>(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if raw_fd < 0 || raw_fd > RawFd::MAX as libc::c_long {
        return Err(BuildReceiptError::new(
            "build_observer_immutable_executor_snapshot_unavailable",
        ));
    }
    let mut snapshot = unsafe { std::fs::File::from_raw_fd(raw_fd as RawFd) };
    snapshot
        .write_all(bytes)
        .map_err(|_| BuildReceiptError::new("build_observer_executor_snapshot_write_failed"))?;
    snapshot
        .flush()
        .map_err(|_| BuildReceiptError::new("build_observer_executor_snapshot_flush_failed"))?;
    if unsafe { libc::fchmod(raw_fd as RawFd, 0o500) } != 0 {
        return Err(BuildReceiptError::new(
            "build_observer_executor_snapshot_permission_failed",
        ));
    }
    let required_seals =
        libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(raw_fd as RawFd, libc::F_ADD_SEALS, required_seals) } != 0 {
        return Err(BuildReceiptError::new(
            "build_observer_executor_snapshot_seal_failed",
        ));
    }
    Ok(snapshot)
}

#[cfg(target_os = "linux")]
fn verify_executable_snapshot_seals(file: &tokio::fs::File) -> Result<(), BuildReceiptError> {
    use std::os::fd::AsRawFd;

    let required_seals =
        libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    let observed = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    if observed < 0 || observed & required_seals != required_seals {
        return Err(BuildReceiptError::new(
            "build_observer_executor_snapshot_seals_missing",
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn verify_executable_snapshot_seals(_file: &tokio::fs::File) -> Result<(), BuildReceiptError> {
    Err(BuildReceiptError::new(
        "build_observer_immutable_executor_snapshot_unavailable",
    ))
}

struct ObservedStdinPipe {
    child_stdio: Option<std::process::Stdio>,
    writer: Option<tokio::fs::File>,
    audit_reader: Option<tokio::fs::File>,
}

impl ObservedStdinPipe {
    fn new() -> Result<Self, BuildReceiptError> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

            let mut pipe_fds = [-1; 2];
            if unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
                return Err(BuildReceiptError::new(
                    "build_observer_input_transport_unavailable",
                ));
            }
            let child_reader = unsafe { OwnedFd::from_raw_fd(pipe_fds[0]) };
            let writer = unsafe { OwnedFd::from_raw_fd(pipe_fds[1]) };
            let audit_fd = unsafe {
                libc::fcntl(child_reader.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0)
            };
            if audit_fd < 0 {
                return Err(BuildReceiptError::new(
                    "build_observer_input_audit_transport_unavailable",
                ));
            }
            let audit_reader = unsafe { OwnedFd::from_raw_fd(audit_fd) };
            let child_file = std::fs::File::from(child_reader);
            let writer = tokio::fs::File::from_std(std::fs::File::from(writer));
            let audit_reader =
                tokio::fs::File::from_std(std::fs::File::from(audit_reader));
            return Ok(Self {
                child_stdio: Some(std::process::Stdio::from(child_file)),
                writer: Some(writer),
                audit_reader: Some(audit_reader),
            });
        }
        #[cfg(not(target_os = "linux"))]
        Err(BuildReceiptError::new(
            "build_observer_input_audit_transport_unavailable",
        ))
    }

    fn take_child_stdio(&mut self) -> Result<std::process::Stdio, BuildReceiptError> {
        self.child_stdio
            .take()
            .ok_or_else(|| BuildReceiptError::new("build_observer_input_transport_is_consumed"))
    }

    fn take_writer(&mut self) -> Result<tokio::fs::File, BuildReceiptError> {
        self.writer
            .take()
            .ok_or_else(|| BuildReceiptError::new("build_observer_input_transport_is_consumed"))
    }

    fn take_audit_reader(&mut self) -> Result<tokio::fs::File, BuildReceiptError> {
        self.audit_reader
            .take()
            .ok_or_else(|| BuildReceiptError::new("build_observer_input_transport_is_consumed"))
    }
}

struct ProcessBoundary {
    #[cfg(target_os = "linux")]
    process_group_id: libc::pid_t,
    #[cfg(target_os = "linux")]
    process_identity: tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>,
}

impl ProcessBoundary {
    fn attach(child: &tokio::process::Child) -> Result<Self, BuildReceiptError> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::{FromRawFd, OwnedFd, RawFd};

            let process_id = child
                .id()
                .filter(|process_id| *process_id <= libc::pid_t::MAX as u32)
                .ok_or_else(|| {
                    BuildReceiptError::new("build_observer_process_identity_unavailable")
                })?;
            let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, process_id, 0) };
            if raw_fd < 0 || raw_fd > RawFd::MAX as libc::c_long {
                return Err(BuildReceiptError::new(
                    "build_observer_stable_process_identity_unavailable",
                ));
            }
            let process_identity = tokio::io::unix::AsyncFd::new(unsafe {
                OwnedFd::from_raw_fd(raw_fd as RawFd)
            })
            .map_err(|_| {
                BuildReceiptError::new("build_observer_stable_process_identity_unavailable")
            })?;
            return Ok(Self {
                process_group_id: process_id as libc::pid_t,
                process_identity,
            });
        }
        #[cfg(not(target_os = "linux"))]
        Err(BuildReceiptError::new(
            "build_observer_process_boundary_unavailable",
        ))
    }

    async fn wait_for_leader_exit(
        &self,
        deadline: TokioInstant,
    ) -> Result<(), BuildReceiptError> {
        #[cfg(target_os = "linux")]
        {
            return match timeout_at(deadline, self.process_identity.readable()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(_)) => Err(BuildReceiptError::new(
                    "build_observer_process_identity_wait_failed",
                )),
                Err(_) => Err(BuildReceiptError::new("build_observer_command_timed_out")),
            };
        }
        #[cfg(not(target_os = "linux"))]
        Err(BuildReceiptError::new(
            "build_observer_process_boundary_unavailable",
        ))
    }

    fn is_quiescent(&self) -> Result<bool, BuildReceiptError> {
        #[cfg(target_os = "linux")]
        {
            let entries = std::fs::read_dir("/proc").map_err(|_| {
                BuildReceiptError::new("build_observer_process_boundary_inspection_failed")
            })?;
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => continue,
                };
                if entry
                    .file_name()
                    .to_string_lossy()
                    .parse::<libc::pid_t>()
                    .is_err()
                {
                    continue;
                }
                let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                    Ok(stat) => stat,
                    Err(_) => continue,
                };
                let Some(after_name) = stat.rsplit_once(')').map(|(_, suffix)| suffix) else {
                    continue;
                };
                let mut fields = after_name.split_whitespace();
                let Some(state) = fields.next().and_then(|value| value.as_bytes().first()).copied()
                else {
                    continue;
                };
                let _parent_process_id = fields.next();
                let process_group_id = fields
                    .next()
                    .and_then(|value| value.parse::<libc::pid_t>().ok());
                if process_group_id == Some(self.process_group_id)
                    && state != b'Z'
                    && state != b'X'
                {
                    return Ok(false);
                }
            }
            return Ok(true);
        }
        #[cfg(not(target_os = "linux"))]
        Err(BuildReceiptError::new(
            "build_observer_process_boundary_unavailable",
        ))
    }

    fn terminate(&self) -> Result<(), BuildReceiptError> {
        #[cfg(target_os = "linux")]
        {
            let result = unsafe { libc::kill(-self.process_group_id, libc::SIGKILL) };
            if result == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return Ok(());
            }
            return Err(BuildReceiptError::new(
                "build_observer_process_boundary_termination_failed",
            ));
        }
        #[cfg(not(target_os = "linux"))]
        Err(BuildReceiptError::new(
            "build_observer_process_boundary_unavailable",
        ))
    }
}

fn configure_process_boundary(
    command: &mut tokio::process::Command,
) -> Result<(), BuildReceiptError> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let filter = process_lineage_filter()?;
        command.as_std_mut().process_group(0);
        unsafe {
            command.as_std_mut().pre_exec(move || {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let program = libc::sock_fprog {
                    len: filter.len() as u16,
                    filter: filter.as_ptr().cast_mut(),
                };
                if libc::syscall(
                    libc::SYS_seccomp,
                    1u32,
                    0u32,
                    &program as *const libc::sock_fprog,
                ) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    Err(BuildReceiptError::new(
        "build_observer_process_boundary_unavailable",
    ))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn process_lineage_filter() -> Result<Vec<libc::sock_filter>, BuildReceiptError> {
    const BPF_LOAD_WORD_ABSOLUTE: u16 = 0x20;
    const BPF_JUMP_EQUAL: u16 = 0x15;
    const BPF_JUMP_SET: u16 = 0x45;
    const BPF_AND: u16 = 0x54;
    const BPF_RETURN: u16 = 0x06;
    const SECCOMP_RETURN_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RETURN_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RETURN_ALLOW: u32 = 0x7fff_0000;
    const AUDIT_ARCH_NATIVE: u32 = 0xc000_003e;
    const X32_SYSCALL_BIT: u32 = 0x4000_0000;
    const SECCOMP_DATA_SYSCALL_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;
    const SECCOMP_DATA_FIRST_ARGUMENT_OFFSET: u32 = 16;

    fn statement(code: u16, value: u32) -> libc::sock_filter {
        libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k: value,
        }
    }

    fn jump(code: u16, value: u32, on_true: u8, on_false: u8) -> libc::sock_filter {
        libc::sock_filter {
            code,
            jt: on_true,
            jf: on_false,
            k: value,
        }
    }

    let deny = SECCOMP_RETURN_ERRNO | libc::EPERM as u32;
    let mut filter = vec![
        statement(BPF_LOAD_WORD_ABSOLUTE, SECCOMP_DATA_ARCH_OFFSET),
        jump(BPF_JUMP_EQUAL, AUDIT_ARCH_NATIVE, 1, 0),
        statement(BPF_RETURN, SECCOMP_RETURN_KILL_PROCESS),
        statement(BPF_LOAD_WORD_ABSOLUTE, SECCOMP_DATA_SYSCALL_OFFSET),
        jump(BPF_JUMP_SET, X32_SYSCALL_BIT, 0, 1),
        statement(BPF_RETURN, deny),
    ];
    for syscall in [
        libc::SYS_setsid,
        libc::SYS_setpgid,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_clone3,
    ] {
        let syscall = u32::try_from(syscall).map_err(|_| {
            BuildReceiptError::new("build_observer_process_boundary_filter_unavailable")
        })?;
        filter.push(jump(BPF_JUMP_EQUAL, syscall, 0, 1));
        filter.push(statement(BPF_RETURN, deny));
    }

    let clone_syscall = u32::try_from(libc::SYS_clone).map_err(|_| {
        BuildReceiptError::new("build_observer_process_boundary_filter_unavailable")
    })?;
    const LINUX_CLONE_NEWTIME_FLAG: u32 = 0x0000_0080;
    let namespace_flags = (libc::CLONE_NEWCGROUP
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWUSER
        | libc::CLONE_NEWUTS) as u32
        | LINUX_CLONE_NEWTIME_FLAG;
    filter.extend([
        jump(BPF_JUMP_EQUAL, clone_syscall, 0, 4),
        statement(
            BPF_LOAD_WORD_ABSOLUTE,
            SECCOMP_DATA_FIRST_ARGUMENT_OFFSET,
        ),
        statement(BPF_AND, namespace_flags),
        jump(BPF_JUMP_EQUAL, 0, 1, 0),
        statement(BPF_RETURN, deny),
        statement(BPF_RETURN, SECCOMP_RETURN_ALLOW),
    ]);
    if filter.len() > u16::MAX as usize {
        return Err(BuildReceiptError::new(
            "build_observer_process_boundary_filter_unavailable",
        ));
    }
    Ok(filter)
}

#[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
fn process_lineage_filter() -> Result<Vec<libc::sock_filter>, BuildReceiptError> {
    Err(BuildReceiptError::new(
        "build_observer_process_boundary_filter_unavailable",
    ))
}

async fn terminate_process_boundary(
    child: &mut tokio::process::Child,
    boundary: &ProcessBoundary,
) -> Result<(), BuildReceiptError> {
    boundary.terminate()?;
    let _ = child.kill().await;
    let _ = child.wait().await;
    for _ in 0..20 {
        if boundary.is_quiescent()? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Err(BuildReceiptError::new(
        "build_observer_process_boundary_cleanup_failed",
    ))
}

async fn terminate_boundary_and_abort_io(
    child: &mut tokio::process::Child,
    boundary: &ProcessBoundary,
    stdin: &mut tokio::task::JoinHandle<std::io::Result<()>>,
    stdout: &mut tokio::task::JoinHandle<Result<Vec<u8>, BuildReceiptError>>,
    stderr: &mut tokio::task::JoinHandle<Result<Vec<u8>, BuildReceiptError>>,
) -> Result<(), BuildReceiptError> {
    let cleanup_result = terminate_process_boundary(child, boundary).await;
    abort_io_tasks(stdin, stdout, stderr).await;
    cleanup_result
}

async fn terminate_untracked_process(child: &mut tokio::process::Child) {
    #[cfg(target_os = "linux")]
    if let Some(process_id) = child
        .id()
        .filter(|process_id| *process_id <= libc::pid_t::MAX as u32)
    {
        let _ = unsafe { libc::kill(-(process_id as libc::pid_t), libc::SIGKILL) };
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn validate_plan(plan: &StdinStdoutBuildStepPlan) -> Result<(), BuildReceiptError> {
    if !plan.executable_locator.is_absolute() {
        return Err(BuildReceiptError::new(
            "build_observer_executor_locator_is_not_absolute",
        ));
    }
    if plan.timeout.is_zero() {
        return Err(BuildReceiptError::new(
            "build_observer_timeout_is_invalid",
        ));
    }
    if plan.stdout_limit_bytes == 0 || plan.stderr_limit_bytes == 0 {
        return Err(BuildReceiptError::new(
            "build_observer_output_limit_is_invalid",
        ));
    }
    for argument in &plan.arguments {
        if os_str_contains_nul(argument) {
            return Err(BuildReceiptError::new(
                "build_observer_argument_contains_nul",
            ));
        }
    }
    Ok(())
}

fn final_environment(plan: &StdinStdoutBuildStepPlan) -> BTreeMap<OsString, OsString> {
    let mut environment = if plan.inherit_parent_environment {
        std::env::vars_os().collect()
    } else {
        BTreeMap::new()
    };
    environment.extend(plan.environment.clone());
    environment
}

fn validate_environment(
    environment: &BTreeMap<OsString, OsString>,
) -> Result<(), BuildReceiptError> {
    for (key, value) in environment {
        if key.is_empty()
            || os_str_contains_nul(key)
            || os_str_contains_nul(value)
            || os_str_contains_byte(key, b'=')
        {
            return Err(BuildReceiptError::new(
                "build_observer_environment_entry_is_invalid",
            ));
        }
    }
    Ok(())
}

fn derive_observed_invocation_hash(
    pinned: &PinnedExecutable,
    plan: &StdinStdoutBuildStepPlan,
    environment: &BTreeMap<OsString, OsString>,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, b"synthi.observed_stdin_stdout_invocation.v1");
    hash_field(&mut hasher, pinned.executable_hash.as_bytes());
    hash_field(&mut hasher, pinned.binding.as_bytes());
    hash_field(&mut hasher, EXECUTION_BOUNDARY.as_bytes());
    hash_field(
        &mut hasher,
        if plan.inherit_parent_environment {
            b"complete_parent_environment_snapshot"
        } else {
            b"explicit_environment_only"
        },
    );
    hasher.update((plan.arguments.len() as u64).to_be_bytes());
    for argument in &plan.arguments {
        hash_os_str(&mut hasher, argument);
    }
    hasher.update((environment.len() as u64).to_be_bytes());
    for (key, value) in environment {
        hash_os_str(&mut hasher, key);
        hash_os_str(&mut hasher, value);
    }
    hash_field(&mut hasher, plan.input_id.as_bytes());
    hash_field(&mut hasher, content_hash(&plan.input_bytes).as_bytes());
    hasher.update((plan.input_bytes.len() as u64).to_be_bytes());
    hasher.update(plan.output_ordinal.to_be_bytes());
    hasher.update(
        (plan.timeout.as_nanos().min(u64::MAX as u128) as u64).to_be_bytes(),
    );
    hasher.update(plan.stdout_limit_bytes.to_be_bytes());
    hasher.update(plan.stderr_limit_bytes.to_be_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

async fn read_held_file(file: &tokio::fs::File) -> Result<Vec<u8>, BuildReceiptError> {
    let mut reader = file
        .try_clone()
        .await
        .map_err(|_| BuildReceiptError::new("build_observer_executor_clone_failed"))?;
    reader
        .seek(std::io::SeekFrom::Start(0))
        .await
        .map_err(|_| BuildReceiptError::new("build_observer_executor_seek_failed"))?;
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| BuildReceiptError::new("build_observer_executor_read_failed"))?;
    Ok(bytes)
}

async fn read_bounded_stream<R>(
    mut reader: R,
    limit: u64,
    overflow_reason: &'static str,
    read_reason: &'static str,
) -> Result<Vec<u8>, BuildReceiptError>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|_| BuildReceiptError::new(read_reason))?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len() as u64) as usize;
        let retained = read.min(remaining);
        bytes.extend_from_slice(&chunk[..retained]);
        if retained != read {
            return Err(BuildReceiptError::new(overflow_reason));
        }
    }
    Ok(bytes)
}

async fn abort_io_tasks(
    stdin: &mut tokio::task::JoinHandle<std::io::Result<()>>,
    stdout: &mut tokio::task::JoinHandle<Result<Vec<u8>, BuildReceiptError>>,
    stderr: &mut tokio::task::JoinHandle<Result<Vec<u8>, BuildReceiptError>>,
) {
    if !stdin.is_finished() {
        stdin.abort();
        let _ = stdin.await;
    }
    if !stdout.is_finished() {
        stdout.abort();
        let _ = stdout.await;
    }
    if !stderr.is_finished() {
        stderr.abort();
        let _ = stderr.await;
    }
}

fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(target_family = "unix"))]
    {
        left.len() == right.len()
            && left.modified().ok() == right.modified().ok()
            && left.created().ok() == right.created().ok()
    }
}

fn os_str_contains_nul(value: &OsStr) -> bool {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::ffi::OsStrExt;
        value.as_bytes().contains(&0)
    }
    #[cfg(target_family = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        value.encode_wide().any(|unit| unit == 0)
    }
    #[cfg(not(any(target_family = "unix", target_family = "windows")))]
    {
        value.to_string_lossy().as_bytes().contains(&0)
    }
}

fn os_str_contains_byte(value: &OsStr, byte: u8) -> bool {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::ffi::OsStrExt;
        value.as_bytes().contains(&byte)
    }
    #[cfg(not(target_family = "unix"))]
    {
        value.to_string_lossy().as_bytes().contains(&byte)
    }
}

fn hash_os_str(hasher: &mut Sha256, value: &OsStr) {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::ffi::OsStrExt;
        hash_field(hasher, value.as_bytes());
    }
    #[cfg(target_family = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut bytes = Vec::new();
        for unit in value.encode_wide() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        hash_field(hasher, &bytes);
    }
    #[cfg(not(any(target_family = "unix", target_family = "windows")))]
    {
        hash_field(hasher, value.to_string_lossy().as_bytes());
    }
}

fn content_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::build_manifest::{
        BuildArtifactIdentity, BuildDependencyIdentity, BuildManifest, BuildSlot,
    };

    const CONTEXT: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const INPUT: &str =
        "artifact-input:sha256:1111111111111111111111111111111111111111111111111111111111111111";

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn observer_records_exact_stdin_stdout_without_build_authority() {
        let input = Arc::<[u8]>::from(b"observer-owned-input".as_slice());
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new("/bin/cat", INPUT, input.clone(), 0)
            .unwrap()
            .timeout(Duration::from_secs(2));
        let outcome = verifier
            .observe_stdin_stdout_step(&challenge, plan)
            .await
            .unwrap();
        assert!(outcome.succeeded());
        assert_eq!(outcome.stdout(), input.as_ref());
        assert!(outcome.stderr().is_empty());
        let receipt = outcome.receipt().unwrap().clone();
        assert!(!receipt.can_satisfy_build_transaction());
        let artifact_hash = content_hash(outcome.stdout());
        let artifact = BuildArtifactIdentity::new("ignored", "transport/output", &artifact_hash)
            .with_byte_length(outcome.stdout().len() as u64)
            .with_reload_role_declaration(
                vec![INPUT.to_string()],
                receipt.invocation_hash().to_string(),
                0,
                Vec::new(),
                vec![BuildDependencyIdentity::new(
                    INPUT,
                    "transport/input",
                    content_hash(&input),
                )],
            )
            .unwrap();
        let manifest = BuildManifest::new(
            "preview-metadata",
            "language-metadata",
            "adapter-metadata",
            0,
            BuildSlot::Full,
            "transport/output",
            artifact_hash,
        )
        .with_artifacts(vec![artifact]);
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt])
                .unwrap_err()
                .to_string(),
            "build_step_receipt_dependency_authority_is_insufficient"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn failed_and_timed_out_processes_never_mint_receipts() {
        let input = Arc::<[u8]>::from(b"input".as_slice());
        let mut verifier = BuildReceiptVerifier::new();
        let failed_challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let failed_plan = StdinStdoutBuildStepPlan::new("/bin/sh", INPUT, input.clone(), 0)
            .unwrap()
            .args(["-c", "/bin/cat >/dev/null; printf failure >&2; exit 9"])
            .timeout(Duration::from_secs(2));
        let failed = verifier
            .observe_stdin_stdout_step(&failed_challenge, failed_plan)
            .await
            .unwrap();
        assert!(!failed.succeeded());
        assert_eq!(failed.exit_code(), Some(9));
        assert!(failed.receipt().is_none());
        assert!(String::from_utf8_lossy(failed.stderr()).contains("failure"));

        let timeout_challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let timeout_plan = StdinStdoutBuildStepPlan::new("/bin/sh", INPUT, input, 0)
            .unwrap()
            .args(["-c", "/bin/sleep 2; /bin/cat"])
            .timeout(Duration::from_millis(20));
        assert_eq!(
            verifier
                .observe_stdin_stdout_step(&timeout_challenge, timeout_plan)
                .await
                .unwrap_err()
                .to_string(),
            "build_observer_command_timed_out"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn successful_process_must_consume_every_observed_input_byte() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new(
            "/bin/sh",
            INPUT,
            Arc::<[u8]>::from(b"unread-input".as_slice()),
            0,
        )
        .unwrap()
        .args(["-c", "printf artifact"])
        .timeout(Duration::from_secs(2));

        assert_eq!(
            verifier
                .observe_stdin_stdout_step(&challenge, plan)
                .await
                .unwrap_err()
                .to_string(),
            "build_observer_input_was_not_fully_consumed"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn descendant_that_retains_observed_pipes_is_bounded_and_refused() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new(
            "/bin/sh",
            INPUT,
            Arc::<[u8]>::from(b"input".as_slice()),
            0,
        )
        .unwrap()
        .args([
            "-c",
            "/bin/cat >/dev/null; /bin/sleep 2 & printf artifact",
        ])
        .timeout(Duration::from_millis(50));

        assert_eq!(
            verifier
                .observe_stdin_stdout_step(&challenge, plan)
                .await
                .unwrap_err()
                .to_string(),
            "build_observer_command_timed_out"
        );
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test]
    async fn observed_process_cannot_escape_its_lineage_boundary() {
        assert!(Path::new("/usr/bin/setsid").is_file());
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new(
            "/bin/sh",
            INPUT,
            Arc::<[u8]>::from(b"input".as_slice()),
            0,
        )
        .unwrap()
        .args([
            "-c",
            "/bin/cat >/dev/null; if /usr/bin/setsid /bin/true 2>/dev/null; then printf escaped; else printf contained; fi",
        ])
        .timeout(Duration::from_secs(2));

        let outcome = verifier
            .observe_stdin_stdout_step(&challenge, plan)
            .await
            .unwrap();
        assert!(outcome.succeeded());
        assert_eq!(outcome.stdout(), b"contained");
        assert!(outcome.receipt().is_some());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn output_overflow_is_refused_after_boundary_cleanup() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new(
            "/bin/sh",
            INPUT,
            Arc::<[u8]>::from(b"input".as_slice()),
            0,
        )
        .unwrap()
        .args([
            "-c",
            "/bin/cat >/dev/null; /usr/bin/head -c 128 /dev/zero",
        ])
        .output_limits(32, 1024)
        .timeout(Duration::from_secs(2));

        assert_eq!(
            verifier
                .observe_stdin_stdout_step(&challenge, plan)
                .await
                .unwrap_err()
                .to_string(),
            "build_observer_stdout_limit_exceeded"
        );
    }

    #[tokio::test]
    async fn relative_executor_locator_fails_before_process_execution() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction(CONTEXT).unwrap();
        let plan = StdinStdoutBuildStepPlan::new(
            "relative-executable",
            INPUT,
            Arc::<[u8]>::from(b"input".as_slice()),
            0,
        )
        .unwrap();
        assert_eq!(
            verifier
                .observe_stdin_stdout_step(&challenge, plan)
                .await
                .unwrap_err()
                .to_string(),
            "build_observer_executor_locator_is_not_absolute"
        );
    }
}
