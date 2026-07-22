use sha2::{Digest, Sha256};
use std::{fmt, io};

pub const CLOSED_EXECUTION_PROCESS_SCHEMA: &str =
    "synthi.closed_execution.atomic_process_observation.v1";
pub const CLOSED_EXECUTION_PROCESS_EVIDENCE_AUTHORITY: &str =
    "kernel_atomic_spawn_observation_only_not_closed_execution_or_gpu_hmr_acceptance";

const IDENTITY_BYTES: usize = 32;
const EXECUTABLE_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.sealed_executable.v1";
const WORKING_DIRECTORY_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.working_directory.v1";
const STDIO_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.stdio.v1";
const VECTOR_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.canonical_vector.v1";
const SPAWN_PLAN_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.spawn_plan.v1";
const PROCESS_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.atomic_process.v1";

#[derive(Debug)]
pub struct ClosedExecutionProcessError {
    code: &'static str,
    child_stage: Option<&'static str>,
    source: Option<io::Error>,
}

impl ClosedExecutionProcessError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            child_stage: None,
            source: None,
        }
    }

    fn with_io(code: &'static str, source: io::Error) -> Self {
        Self {
            code,
            child_stage: None,
            source: Some(source),
        }
    }

    fn child(stage: &'static str, source: io::Error) -> Self {
        Self {
            code: "closed_execution_child_pre_exec_failed",
            child_stage: Some(stage),
            source: Some(source),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn child_stage(&self) -> Option<&'static str> {
        self.child_stage
    }
}

impl fmt::Display for ClosedExecutionProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ClosedExecutionProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClosedExecutionIdentity([u8; IDENTITY_BYTES]);

impl ClosedExecutionIdentity {
    pub fn as_bytes(&self) -> &[u8; IDENTITY_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ClosedExecutionIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ClosedExecutionIdentity")
            .field(&hex::encode(self.0))
            .finish()
    }
}

fn hash_identity(domain: &[u8], fields: &[&[u8]]) -> ClosedExecutionIdentity {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    ClosedExecutionIdentity(hasher.finalize().into())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::runtime::cgroup_process_set::{
        CgroupProcessSet, CgroupProcessSetCleanup, ProcessSetSeed,
    };
    use std::{
        ffi::{CStr, CString, OsString},
        mem::MaybeUninit,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
            unix::ffi::OsStringExt,
        },
        ptr,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread,
    };

    const REQUIRED_EXECUTABLE_SEALS: libc::c_int =
        libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    const CHILD_FD_FLOOR: libc::c_int = 64;
    const CHILD_EXECUTABLE_FD: libc::c_int = 3;
    const CHILD_STATUS_FD: libc::c_int = 4;
    const CHILD_FAILURE_BYTES: usize = 12;
    const CHILD_FAILURE_MAGIC: [u8; 4] = *b"SCEF";
    const CHILD_FAILURE_VERSION: u8 = 1;
    const LINUX_CLONE_PIDFD: u64 = 0x0000_1000;
    const LINUX_CLONE_INTO_CGROUP: u64 = 0x2_0000_0000;
    const LINUX_CLOSE_RANGE_UNSHARE: libc::c_uint = 1 << 1;

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct LinuxCloneArgs {
        flags: u64,
        pidfd: u64,
        child_tid: u64,
        parent_tid: u64,
        exit_signal: u64,
        stack: u64,
        stack_size: u64,
        tls: u64,
        set_tid: u64,
        set_tid_size: u64,
        cgroup: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[repr(u8)]
    enum ChildStage {
        Ptrace = 1,
        Stop = 2,
        WorkingDirectory = 3,
        Stdin = 4,
        Stdout = 5,
        Stderr = 6,
        ExecutableDescriptor = 7,
        StatusDescriptor = 8,
        DescriptorClosure = 9,
        SupplementaryGroups = 10,
        GroupIdentity = 11,
        UserIdentity = 12,
        NoNewPrivileges = 13,
        Exec = 14,
    }

    impl ChildStage {
        fn code(self) -> &'static str {
            match self {
                Self::Ptrace => "ptrace_traceme",
                Self::Stop => "pre_exec_stop",
                Self::WorkingDirectory => "working_directory",
                Self::Stdin => "stdin",
                Self::Stdout => "stdout",
                Self::Stderr => "stderr",
                Self::ExecutableDescriptor => "executable_descriptor",
                Self::StatusDescriptor => "status_descriptor",
                Self::DescriptorClosure => "descriptor_closure",
                Self::SupplementaryGroups => "supplementary_groups",
                Self::GroupIdentity => "group_identity",
                Self::UserIdentity => "user_identity",
                Self::NoNewPrivileges => "no_new_privileges",
                Self::Exec => "execveat",
            }
        }

        fn from_wire(value: u8) -> Option<Self> {
            Some(match value {
                1 => Self::Ptrace,
                2 => Self::Stop,
                3 => Self::WorkingDirectory,
                4 => Self::Stdin,
                5 => Self::Stdout,
                6 => Self::Stderr,
                7 => Self::ExecutableDescriptor,
                8 => Self::StatusDescriptor,
                9 => Self::DescriptorClosure,
                10 => Self::SupplementaryGroups,
                11 => Self::GroupIdentity,
                12 => Self::UserIdentity,
                13 => Self::NoNewPrivileges,
                14 => Self::Exec,
                _ => return None,
            })
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SpawnInputLimits {
        max_argument_count: usize,
        max_environment_count: usize,
        max_total_bytes: usize,
    }

    impl SpawnInputLimits {
        pub fn new(
            max_argument_count: usize,
            max_environment_count: usize,
            max_total_bytes: usize,
        ) -> Result<Self, ClosedExecutionProcessError> {
            if max_argument_count == 0 || max_total_bytes == 0 {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_spawn_limits_invalid",
                ));
            }
            Ok(Self {
                max_argument_count,
                max_environment_count,
                max_total_bytes,
            })
        }
    }

    #[derive(Debug)]
    pub struct SealedExecutable {
        fd: OwnedFd,
        identity: ClosedExecutionIdentity,
        content_digest: [u8; IDENTITY_BYTES],
        byte_length: u64,
    }

    impl SealedExecutable {
        pub fn from_fd(
            fd: OwnedFd,
            expected_content_digest: [u8; IDENTITY_BYTES],
            expected_byte_length: u64,
        ) -> Result<Self, ClosedExecutionProcessError> {
            if expected_content_digest == [0; IDENTITY_BYTES] || expected_byte_length == 0 {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_executable_identity_invalid",
                ));
            }
            let stat = stat_fd(fd.as_raw_fd(), "closed_execution_executable_stat_failed")?;
            if stat.st_mode & libc::S_IFMT != libc::S_IFREG
                || stat.st_size < 0
                || stat.st_size as u64 != expected_byte_length
                || stat.st_mode & 0o001 == 0
                || stat.st_mode & 0o022 != 0
            {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_executable_metadata_invalid",
                ));
            }
            let observed_seals = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GET_SEALS) };
            if observed_seals < 0
                || observed_seals & REQUIRED_EXECUTABLE_SEALS != REQUIRED_EXECUTABLE_SEALS
            {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_executable_seals_missing",
                ));
            }
            let observed_digest = hash_fd_bytes(fd.as_raw_fd(), expected_byte_length)?;
            if observed_digest != expected_content_digest {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_executable_hash_mismatch",
                ));
            }
            let byte_length = expected_byte_length;
            let device = stat.st_dev as u64;
            let inode = stat.st_ino as u64;
            let mode = stat.st_mode;
            let identity = hash_identity(
                EXECUTABLE_IDENTITY_DOMAIN,
                &[
                    &expected_content_digest,
                    &byte_length.to_be_bytes(),
                    &device.to_be_bytes(),
                    &inode.to_be_bytes(),
                    &mode.to_be_bytes(),
                    &observed_seals.to_be_bytes(),
                ],
            );
            Ok(Self {
                fd,
                identity,
                content_digest: expected_content_digest,
                byte_length,
            })
        }

        pub fn identity(&self) -> ClosedExecutionIdentity {
            self.identity
        }

        pub fn content_digest(&self) -> &[u8; IDENTITY_BYTES] {
            &self.content_digest
        }

        pub fn byte_length(&self) -> u64 {
            self.byte_length
        }
    }

    #[derive(Debug)]
    pub struct PinnedWorkingDirectory {
        fd: OwnedFd,
        identity: ClosedExecutionIdentity,
    }

    impl PinnedWorkingDirectory {
        pub fn from_fd(fd: OwnedFd) -> Result<Self, ClosedExecutionProcessError> {
            let stat = stat_fd(
                fd.as_raw_fd(),
                "closed_execution_working_directory_stat_failed",
            )?;
            if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_working_directory_not_directory",
                ));
            }
            let device = stat.st_dev as u64;
            let inode = stat.st_ino as u64;
            let mode = stat.st_mode;
            let identity = hash_identity(
                WORKING_DIRECTORY_IDENTITY_DOMAIN,
                &[
                    &device.to_be_bytes(),
                    &inode.to_be_bytes(),
                    &mode.to_be_bytes(),
                ],
            );
            Ok(Self { fd, identity })
        }

        pub fn identity(&self) -> ClosedExecutionIdentity {
            self.identity
        }
    }

    #[derive(Debug)]
    pub struct ClosedExecutionStdio {
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
        identity: ClosedExecutionIdentity,
    }

    impl ClosedExecutionStdio {
        pub fn new(
            stdin: OwnedFd,
            stdout: OwnedFd,
            stderr: OwnedFd,
        ) -> Result<Self, ClosedExecutionProcessError> {
            let stdin_identity = descriptor_identity(&stdin, false)?;
            let stdout_identity = descriptor_identity(&stdout, true)?;
            let stderr_identity = descriptor_identity(&stderr, true)?;
            let identity = hash_identity(
                STDIO_IDENTITY_DOMAIN,
                &[
                    stdin_identity.as_bytes(),
                    stdout_identity.as_bytes(),
                    stderr_identity.as_bytes(),
                ],
            );
            Ok(Self {
                stdin,
                stdout,
                stderr,
                identity,
            })
        }

        pub fn identity(&self) -> ClosedExecutionIdentity {
            self.identity
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ExecutionCredentials {
        uid: libc::uid_t,
        gid: libc::gid_t,
    }

    impl ExecutionCredentials {
        pub fn unprivileged(
            uid: libc::uid_t,
            gid: libc::gid_t,
        ) -> Result<Self, ClosedExecutionProcessError> {
            if uid == 0 || gid == 0 {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_privileged_target_identity_refused",
                ));
            }
            Ok(Self { uid, gid })
        }

        pub fn uid(&self) -> libc::uid_t {
            self.uid
        }

        pub fn gid(&self) -> libc::gid_t {
            self.gid
        }
    }

    #[derive(Debug)]
    pub struct ClosedExecutionSpawnPlan {
        executable: SealedExecutable,
        working_directory: PinnedWorkingDirectory,
        stdio: ClosedExecutionStdio,
        credentials: ExecutionCredentials,
        argv: Vec<CString>,
        environment: Vec<CString>,
        umask: libc::mode_t,
        identity: ClosedExecutionIdentity,
    }

    impl ClosedExecutionSpawnPlan {
        #[allow(clippy::too_many_arguments)]
        pub fn new(
            executable: SealedExecutable,
            working_directory: PinnedWorkingDirectory,
            stdio: ClosedExecutionStdio,
            credentials: ExecutionCredentials,
            argv: Vec<OsString>,
            environment: Vec<(OsString, OsString)>,
            umask: libc::mode_t,
            limits: SpawnInputLimits,
        ) -> Result<Self, ClosedExecutionProcessError> {
            if argv.is_empty()
                || argv.len() > limits.max_argument_count
                || environment.len() > limits.max_environment_count
                || umask & !0o777 != 0
            {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_spawn_plan_invalid",
                ));
            }

            let mut total_bytes = 0usize;
            let argv = argv
                .into_iter()
                .map(|value| {
                    let value = CString::new(value.into_vec()).map_err(|_| {
                        ClosedExecutionProcessError::new("closed_execution_argument_contains_nul")
                    })?;
                    total_bytes = total_bytes
                        .checked_add(value.as_bytes_with_nul().len())
                        .ok_or_else(|| {
                            ClosedExecutionProcessError::new(
                                "closed_execution_spawn_input_size_overflow",
                            )
                        })?;
                    Ok(value)
                })
                .collect::<Result<Vec<_>, _>>()?;

            let mut environment_entries = Vec::with_capacity(environment.len());
            for (key, value) in environment {
                let key = key.into_vec();
                let value = value.into_vec();
                if key.is_empty() || key.contains(&0) || key.contains(&b'=') || value.contains(&0) {
                    return Err(ClosedExecutionProcessError::new(
                        "closed_execution_environment_entry_invalid",
                    ));
                }
                let mut entry = Vec::with_capacity(key.len() + value.len() + 1);
                entry.extend_from_slice(&key);
                entry.push(b'=');
                entry.extend_from_slice(&value);
                let entry = CString::new(entry).map_err(|_| {
                    ClosedExecutionProcessError::new("closed_execution_environment_entry_invalid")
                })?;
                total_bytes = total_bytes
                    .checked_add(entry.as_bytes_with_nul().len())
                    .ok_or_else(|| {
                        ClosedExecutionProcessError::new(
                            "closed_execution_spawn_input_size_overflow",
                        )
                    })?;
                environment_entries.push((key, entry));
            }
            environment_entries.sort_by(|left, right| left.0.cmp(&right.0));
            if environment_entries
                .windows(2)
                .any(|entries| entries[0].0 == entries[1].0)
            {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_environment_key_duplicate",
                ));
            }
            if total_bytes > limits.max_total_bytes {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_spawn_input_limit_exceeded",
                ));
            }
            let environment = environment_entries
                .into_iter()
                .map(|(_, entry)| entry)
                .collect::<Vec<_>>();
            let argv_identity = vector_identity(&argv);
            let environment_identity = vector_identity(&environment);
            let identity = hash_identity(
                SPAWN_PLAN_IDENTITY_DOMAIN,
                &[
                    executable.identity.as_bytes(),
                    working_directory.identity.as_bytes(),
                    stdio.identity.as_bytes(),
                    &credentials.uid.to_be_bytes(),
                    &credentials.gid.to_be_bytes(),
                    &umask.to_be_bytes(),
                    argv_identity.as_bytes(),
                    environment_identity.as_bytes(),
                ],
            );
            Ok(Self {
                executable,
                working_directory,
                stdio,
                credentials,
                argv,
                environment,
                umask,
                identity,
            })
        }

        pub fn identity(&self) -> ClosedExecutionIdentity {
            self.identity
        }

        pub fn process_set_seed(&self) -> Result<ProcessSetSeed, ClosedExecutionProcessError> {
            ProcessSetSeed::from_content_digest(*self.identity.as_bytes()).map_err(|_| {
                ClosedExecutionProcessError::new("closed_execution_process_set_seed_invalid")
            })
        }
    }

    fn ensure_process_set_bound_to_plan(
        process_set_seed: ProcessSetSeed,
        process_set_identity: &[u8; IDENTITY_BYTES],
        expected_process_set_identity: &[u8; IDENTITY_BYTES],
        plan: &ClosedExecutionSpawnPlan,
    ) -> Result<(), ClosedExecutionProcessError> {
        if process_set_identity != expected_process_set_identity {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_process_set_identity_mismatch",
            ));
        }
        if process_set_seed != plan.process_set_seed()? {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_process_set_spawn_plan_mismatch",
            ));
        }
        Ok(())
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct AtomicSpawnObservation {
        process_identity: ClosedExecutionIdentity,
        spawn_plan_identity: ClosedExecutionIdentity,
        process_set_identity: [u8; IDENTITY_BYTES],
        leader_pid: u32,
        clone_into_cgroup_observed: bool,
        clone_pidfd_observed: bool,
        initial_membership_exact: bool,
        ptrace_exec_event_observed: bool,
        attached_before_exec: bool,
        spawned_monotonic_ns: u64,
        attached_monotonic_ns: u64,
        exec_observed_monotonic_ns: u64,
        migration_protection_observed: bool,
        can_authorize_closed_execution: bool,
    }

    impl AtomicSpawnObservation {
        pub fn process_identity(&self) -> ClosedExecutionIdentity {
            self.process_identity
        }

        pub fn spawn_plan_identity(&self) -> ClosedExecutionIdentity {
            self.spawn_plan_identity
        }

        pub fn process_set_identity(&self) -> &[u8; IDENTITY_BYTES] {
            &self.process_set_identity
        }

        pub fn leader_pid(&self) -> u32 {
            self.leader_pid
        }

        pub fn attached_before_exec(&self) -> bool {
            self.attached_before_exec
        }

        pub fn clone_into_cgroup_observed(&self) -> bool {
            self.clone_into_cgroup_observed
        }

        pub fn clone_pidfd_observed(&self) -> bool {
            self.clone_pidfd_observed
        }

        pub fn initial_membership_exact(&self) -> bool {
            self.initial_membership_exact
        }

        pub fn ptrace_exec_event_observed(&self) -> bool {
            self.ptrace_exec_event_observed
        }

        pub fn spawned_monotonic_ns(&self) -> u64 {
            self.spawned_monotonic_ns
        }

        pub fn attached_monotonic_ns(&self) -> u64 {
            self.attached_monotonic_ns
        }

        pub fn exec_observed_monotonic_ns(&self) -> u64 {
            self.exec_observed_monotonic_ns
        }

        pub fn migration_protection_observed(&self) -> bool {
            self.migration_protection_observed
        }

        pub fn can_authorize_closed_execution(&self) -> bool {
            self.can_authorize_closed_execution
        }
    }

    pub struct AtomicContainedProcess {
        process_set: CgroupProcessSet,
        pidfd: OwnedFd,
        leader_pid: libc::pid_t,
        execution_deadline_monotonic_ns: u64,
        cleanup_deadline_monotonic_ns: u64,
        watchdog: DeadlineWatchdog,
        observation: AtomicSpawnObservation,
        finished: bool,
    }

    impl AtomicContainedProcess {
        pub fn observation(&self) -> &AtomicSpawnObservation {
            &self.observation
        }

        pub fn execution_deadline_monotonic_ns(&self) -> u64 {
            self.execution_deadline_monotonic_ns
        }

        pub fn finish(mut self) -> Result<AtomicProcessCompletion, ClosedExecutionProcessError> {
            let status = wait_for_child(self.leader_pid)?;
            let leader_exit_observed_monotonic_ns = monotonic_now_ns()?;
            let deadline_fired = self.watchdog.cancel()?;
            let leader_pidfd_exit_observed = pidfd_exit_observed(self.pidfd.as_raw_fd())?;
            if !leader_pidfd_exit_observed {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_leader_pidfd_exit_not_observed",
                ));
            }
            let timed_out = deadline_fired;
            let (exit_code, terminating_signal) = decode_exit_status(status)?;
            let cleanup = self
                .process_set
                .kill_and_remove_support_only(self.cleanup_deadline_monotonic_ns)
                .map_err(|error| {
                    ClosedExecutionProcessError::new(match error.code() {
                        "cgroup_process_set_quiescence_deadline_reached" => {
                            "closed_execution_process_set_cleanup_deadline_reached"
                        }
                        _ => "closed_execution_process_set_cleanup_failed",
                    })
                })?;
            let completion = AtomicProcessCompletion {
                process_identity: self.observation.process_identity,
                leader_pid: self.observation.leader_pid,
                exit_code,
                terminating_signal,
                timed_out,
                leader_pidfd_exit_observed,
                leader_exit_observed_monotonic_ns,
                cleanup,
                descendant_termination_proven: false,
                migration_protection_observed: false,
                can_authorize_closed_execution: false,
            };
            self.finished = true;
            Ok(completion)
        }
    }

    impl Drop for AtomicContainedProcess {
        fn drop(&mut self) {
            if self.finished {
                return;
            }
            let _ = pidfd_send_signal(self.pidfd.as_raw_fd(), libc::SIGKILL);
            let _ = self
                .process_set
                .kill_and_remove_support_only(self.cleanup_deadline_monotonic_ns);
            let _ = wait_for_child(self.leader_pid);
            let _ = self.watchdog.cancel();
        }
    }

    impl fmt::Debug for AtomicContainedProcess {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("AtomicContainedProcess")
                .field("leader_pid", &self.leader_pid)
                .field("process_identity", &self.observation.process_identity)
                .field("pidfd_bound", &true)
                .finish_non_exhaustive()
        }
    }

    #[derive(Debug)]
    pub struct AtomicProcessCompletion {
        process_identity: ClosedExecutionIdentity,
        leader_pid: u32,
        exit_code: Option<i32>,
        terminating_signal: Option<i32>,
        timed_out: bool,
        leader_pidfd_exit_observed: bool,
        leader_exit_observed_monotonic_ns: u64,
        cleanup: CgroupProcessSetCleanup,
        descendant_termination_proven: bool,
        migration_protection_observed: bool,
        can_authorize_closed_execution: bool,
    }

    impl AtomicProcessCompletion {
        pub fn process_identity(&self) -> ClosedExecutionIdentity {
            self.process_identity
        }

        pub fn leader_pid(&self) -> u32 {
            self.leader_pid
        }

        pub fn exit_code(&self) -> Option<i32> {
            self.exit_code
        }

        pub fn terminating_signal(&self) -> Option<i32> {
            self.terminating_signal
        }

        pub fn timed_out(&self) -> bool {
            self.timed_out
        }

        pub fn leader_pidfd_exit_observed(&self) -> bool {
            self.leader_pidfd_exit_observed
        }

        pub fn leader_exit_observed_monotonic_ns(&self) -> u64 {
            self.leader_exit_observed_monotonic_ns
        }

        pub fn cleanup(&self) -> &CgroupProcessSetCleanup {
            &self.cleanup
        }

        pub fn descendant_termination_proven(&self) -> bool {
            self.descendant_termination_proven
        }

        pub fn migration_protection_observed(&self) -> bool {
            self.migration_protection_observed
        }

        pub fn can_authorize_closed_execution(&self) -> bool {
            self.can_authorize_closed_execution
        }
    }

    pub fn spawn_atomic_process(
        mut process_set: CgroupProcessSet,
        expected_process_set_identity: [u8; IDENTITY_BYTES],
        plan: ClosedExecutionSpawnPlan,
        execution_deadline_monotonic_ns: u64,
        cleanup_deadline_monotonic_ns: u64,
    ) -> Result<AtomicContainedProcess, ClosedExecutionProcessError> {
        // Identity equality is defense in depth; authenticated provenance for the
        // expected identity belongs to the supervisor lease that calls this primitive.
        let process_set_observation = process_set.observation();
        ensure_process_set_bound_to_plan(
            process_set_observation.seed(),
            process_set_observation.process_set_identity().as_bytes(),
            &expected_process_set_identity,
            &plan,
        )?;
        ensure_execution_identity_separated(plan.credentials, unsafe { libc::geteuid() })?;
        let spawned_monotonic_ns = monotonic_now_ns()?;
        if execution_deadline_monotonic_ns <= spawned_monotonic_ns
            || cleanup_deadline_monotonic_ns <= execution_deadline_monotonic_ns
        {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_deadlines_invalid",
            ));
        }
        let clone_target = process_set.clone_target_fd().map_err(|_| {
            ClosedExecutionProcessError::new("closed_execution_clone_target_unavailable")
        })?;
        let child_fds = ChildFds::from_plan(&plan)?;
        let (status_read, status_write_original) = pipe_cloexec()?;
        let status_write = duplicate_fd_min(status_write_original.as_raw_fd())?;
        drop(status_write_original);
        let argv = pointer_vector(&plan.argv);
        let environment = pointer_vector(&plan.environment);
        let mut raw_pidfd: libc::c_int = -1;
        let clone_args = clone_arguments(&mut raw_pidfd, clone_target.as_raw_fd());
        let clone_result = unsafe {
            libc::syscall(
                libc::SYS_clone3,
                &clone_args as *const LinuxCloneArgs,
                std::mem::size_of::<LinuxCloneArgs>(),
            )
        };
        if clone_result == 0 {
            unsafe {
                child_exec(
                    &child_fds,
                    status_write.as_raw_fd(),
                    plan.credentials,
                    plan.umask,
                    argv.as_ptr(),
                    environment.as_ptr(),
                )
            }
        }
        drop(status_write);
        if clone_result < 0 {
            close_raw_fd_if_valid(raw_pidfd);
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_clone3_failed",
                io::Error::last_os_error(),
            ));
        }
        if clone_result > libc::pid_t::MAX as libc::c_long {
            close_raw_fd_if_valid(raw_pidfd);
            let _ = process_set.kill_and_remove_support_only(cleanup_deadline_monotonic_ns);
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_clone3_pid_invalid",
            ));
        }
        let leader_pid = clone_result as libc::pid_t;
        if raw_pidfd < 0 {
            abort_spawn_without_pidfd(process_set, leader_pid, cleanup_deadline_monotonic_ns);
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_clone3_pidfd_missing",
            ));
        }
        let pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd) };
        if let Err(error) = set_fd_cloexec(pidfd.as_raw_fd()) {
            abort_spawn(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
            );
            return Err(error);
        }
        let pidfd_pid = match pidfd_process_id(pidfd.as_raw_fd()) {
            Ok(pid) => pid,
            Err(error) => {
                abort_spawn(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                );
                return Err(error);
            }
        };
        if pidfd_pid != leader_pid {
            abort_spawn(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
            );
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_pidfd_identity_mismatch",
            ));
        }
        let mut watchdog = match DeadlineWatchdog::start(&pidfd, execution_deadline_monotonic_ns) {
            Ok(watchdog) => watchdog,
            Err(error) => {
                abort_spawn(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                );
                return Err(error);
            }
        };
        let initial_status = match wait_for_child(leader_pid) {
            Ok(status) => status,
            Err(error) => {
                abort_spawn_with_watchdog(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                    &mut watchdog,
                );
                return Err(error);
            }
        };
        if watchdog.fired() {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                child_was_reaped(initial_status),
                &mut watchdog,
            );
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_spawn_deadline_reached",
            ));
        }
        if !libc::WIFSTOPPED(initial_status) || libc::WSTOPSIG(initial_status) != libc::SIGSTOP {
            let error = child_failure_from_status(&status_read, initial_status);
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                child_was_reaped(initial_status),
                &mut watchdog,
            );
            return Err(error);
        }

        let membership = match process_set.membership_snapshot() {
            Ok(membership) => membership,
            Err(_) => {
                abort_spawn_with_watchdog(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                    &mut watchdog,
                );
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_membership_observation_failed",
                ));
            }
        };
        if membership.duplicate_pid_observed() || membership.pids() != [leader_pid as u32] {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
                &mut watchdog,
            );
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_initial_membership_not_exact",
            ));
        }
        let attached_monotonic_ns = membership.observed_monotonic_ns();
        if let Err(error) = ptrace_set_exec_observation(leader_pid) {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
                &mut watchdog,
            );
            return Err(error);
        }
        if let Err(error) = ptrace_continue(leader_pid) {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
                &mut watchdog,
            );
            return Err(error);
        }
        let exec_status = match wait_for_child(leader_pid) {
            Ok(status) => status,
            Err(error) => {
                abort_spawn_with_watchdog(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                    &mut watchdog,
                );
                return Err(error);
            }
        };
        if watchdog.fired() {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                child_was_reaped(exec_status),
                &mut watchdog,
            );
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_spawn_deadline_reached",
            ));
        }
        if !ptrace_exec_event(exec_status) {
            let error = child_failure_from_status(&status_read, exec_status);
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                child_was_reaped(exec_status),
                &mut watchdog,
            );
            return Err(error);
        }
        let exec_observed_monotonic_ns = match monotonic_now_ns() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                abort_spawn_with_watchdog(
                    process_set,
                    &pidfd,
                    leader_pid,
                    cleanup_deadline_monotonic_ns,
                    false,
                    &mut watchdog,
                );
                return Err(error);
            }
        };
        if exec_observed_monotonic_ns >= execution_deadline_monotonic_ns {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
                &mut watchdog,
            );
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_spawn_deadline_reached",
            ));
        }
        // Detach is the final fallible spawn step. Until it succeeds, the tracee has not
        // executed user code, so every abort path above can only contain the stopped leader.
        if let Err(error) = ptrace_detach(leader_pid) {
            abort_spawn_with_watchdog(
                process_set,
                &pidfd,
                leader_pid,
                cleanup_deadline_monotonic_ns,
                false,
                &mut watchdog,
            );
            return Err(error);
        }
        let process_set_identity = *process_set.observation().process_set_identity().as_bytes();
        let process_identity = hash_identity(
            PROCESS_IDENTITY_DOMAIN,
            &[
                plan.identity.as_bytes(),
                &process_set_identity,
                &(leader_pid as u32).to_be_bytes(),
                &spawned_monotonic_ns.to_be_bytes(),
                &attached_monotonic_ns.to_be_bytes(),
                &exec_observed_monotonic_ns.to_be_bytes(),
            ],
        );
        Ok(AtomicContainedProcess {
            process_set,
            pidfd,
            leader_pid,
            execution_deadline_monotonic_ns,
            cleanup_deadline_monotonic_ns,
            watchdog,
            observation: AtomicSpawnObservation {
                process_identity,
                spawn_plan_identity: plan.identity,
                process_set_identity,
                leader_pid: leader_pid as u32,
                clone_into_cgroup_observed: true,
                clone_pidfd_observed: true,
                initial_membership_exact: true,
                ptrace_exec_event_observed: true,
                attached_before_exec: true,
                spawned_monotonic_ns,
                attached_monotonic_ns,
                exec_observed_monotonic_ns,
                migration_protection_observed: false,
                can_authorize_closed_execution: false,
            },
            finished: false,
        })
    }

    struct ChildFds {
        executable: OwnedFd,
        working_directory: OwnedFd,
        stdin: OwnedFd,
        stdout: OwnedFd,
        stderr: OwnedFd,
    }

    impl ChildFds {
        fn from_plan(plan: &ClosedExecutionSpawnPlan) -> Result<Self, ClosedExecutionProcessError> {
            Ok(Self {
                executable: duplicate_fd_min(plan.executable.fd.as_raw_fd())?,
                working_directory: duplicate_fd_min(plan.working_directory.fd.as_raw_fd())?,
                stdin: duplicate_fd_min(plan.stdio.stdin.as_raw_fd())?,
                stdout: duplicate_fd_min(plan.stdio.stdout.as_raw_fd())?,
                stderr: duplicate_fd_min(plan.stdio.stderr.as_raw_fd())?,
            })
        }
    }

    struct DeadlineWatchdog {
        cancel: OwnedFd,
        fired: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl DeadlineWatchdog {
        fn start(
            pidfd: &OwnedFd,
            deadline_monotonic_ns: u64,
        ) -> Result<Self, ClosedExecutionProcessError> {
            let timer = create_absolute_timer(deadline_monotonic_ns)?;
            let cancel = create_eventfd()?;
            let cancel_reader = duplicate_fd_min(cancel.as_raw_fd())?;
            let pidfd = duplicate_fd_min(pidfd.as_raw_fd())?;
            let fired = Arc::new(AtomicBool::new(false));
            let thread_fired = fired.clone();
            let thread = thread::Builder::new()
                .name("closed-execution-deadline".to_string())
                .spawn(move || {
                    let mut descriptors = [
                        libc::pollfd {
                            fd: timer.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: cancel_reader.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                        libc::pollfd {
                            fd: pidfd.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        },
                    ];
                    loop {
                        let result = unsafe { libc::poll(descriptors.as_mut_ptr(), 3, -1) };
                        if result < 0
                            && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted
                        {
                            continue;
                        }
                        if watchdog_poll_should_fire(
                            result,
                            descriptors[1].revents,
                            descriptors[2].revents,
                        ) {
                            thread_fired.store(true, Ordering::Release);
                            let _ = pidfd_send_signal(pidfd.as_raw_fd(), libc::SIGKILL);
                        }
                        return;
                    }
                })
                .map_err(|error| {
                    ClosedExecutionProcessError::with_io(
                        "closed_execution_watchdog_thread_failed",
                        error,
                    )
                })?;
            Ok(Self {
                cancel,
                fired,
                thread: Some(thread),
            })
        }

        fn fired(&self) -> bool {
            self.fired.load(Ordering::Acquire)
        }

        fn cancel(&mut self) -> Result<bool, ClosedExecutionProcessError> {
            if self.thread.is_some() {
                write_eventfd(self.cancel.as_raw_fd())?;
                if let Some(thread) = self.thread.take() {
                    thread.join().map_err(|_| {
                        ClosedExecutionProcessError::new(
                            "closed_execution_watchdog_thread_panicked",
                        )
                    })?;
                }
            }
            Ok(self.fired())
        }
    }

    impl Drop for DeadlineWatchdog {
        fn drop(&mut self) {
            if self.thread.is_none() {
                return;
            }
            let _ = write_eventfd(self.cancel.as_raw_fd());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn watchdog_poll_should_fire(
        poll_result: libc::c_int,
        cancel_revents: libc::c_short,
        pidfd_revents: libc::c_short,
    ) -> bool {
        if poll_result > 0 && pidfd_revents & libc::POLLIN != 0 {
            return false;
        }
        if poll_result > 0 && cancel_revents & libc::POLLIN != 0 {
            return false;
        }
        true
    }

    fn clone_arguments(pidfd: &mut libc::c_int, cgroup: RawFd) -> LinuxCloneArgs {
        LinuxCloneArgs {
            flags: LINUX_CLONE_PIDFD | LINUX_CLONE_INTO_CGROUP,
            pidfd: (pidfd as *mut libc::c_int) as usize as u64,
            exit_signal: libc::SIGCHLD as u64,
            cgroup: cgroup as u64,
            ..LinuxCloneArgs::default()
        }
    }

    unsafe fn child_exec(
        child_fds: &ChildFds,
        status_fd: RawFd,
        credentials: ExecutionCredentials,
        umask: libc::mode_t,
        argv: *const *const libc::c_char,
        environment: *const *const libc::c_char,
    ) -> ! {
        if libc::ptrace(
            libc::PTRACE_TRACEME,
            0,
            ptr::null_mut::<libc::c_void>(),
            ptr::null_mut::<libc::c_void>(),
        ) != 0
        {
            child_fail(status_fd, ChildStage::Ptrace);
        }
        if libc::kill(libc::getpid(), libc::SIGSTOP) != 0 {
            child_fail(status_fd, ChildStage::Stop);
        }
        if libc::fchdir(child_fds.working_directory.as_raw_fd()) != 0 {
            child_fail(status_fd, ChildStage::WorkingDirectory);
        }
        child_dup3(
            child_fds.stdin.as_raw_fd(),
            libc::STDIN_FILENO,
            0,
            status_fd,
            ChildStage::Stdin,
        );
        child_dup3(
            child_fds.stdout.as_raw_fd(),
            libc::STDOUT_FILENO,
            0,
            status_fd,
            ChildStage::Stdout,
        );
        child_dup3(
            child_fds.stderr.as_raw_fd(),
            libc::STDERR_FILENO,
            0,
            status_fd,
            ChildStage::Stderr,
        );
        child_dup3(
            child_fds.executable.as_raw_fd(),
            CHILD_EXECUTABLE_FD,
            0,
            status_fd,
            ChildStage::ExecutableDescriptor,
        );
        child_dup3(
            status_fd,
            CHILD_STATUS_FD,
            libc::O_CLOEXEC,
            status_fd,
            ChildStage::StatusDescriptor,
        );
        if libc::syscall(
            libc::SYS_close_range,
            (CHILD_STATUS_FD + 1) as libc::c_uint,
            libc::c_uint::MAX,
            LINUX_CLOSE_RANGE_UNSHARE,
        ) != 0
        {
            child_fail(CHILD_STATUS_FD, ChildStage::DescriptorClosure);
        }
        if libc::setgroups(0, ptr::null()) != 0 {
            child_fail(CHILD_STATUS_FD, ChildStage::SupplementaryGroups);
        }
        if libc::setresgid(credentials.gid, credentials.gid, credentials.gid) != 0 {
            child_fail(CHILD_STATUS_FD, ChildStage::GroupIdentity);
        }
        if libc::setresuid(credentials.uid, credentials.uid, credentials.uid) != 0 {
            child_fail(CHILD_STATUS_FD, ChildStage::UserIdentity);
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            child_fail(CHILD_STATUS_FD, ChildStage::NoNewPrivileges);
        }
        libc::umask(umask);
        let empty = b"\0";
        libc::syscall(
            libc::SYS_execveat,
            CHILD_EXECUTABLE_FD,
            empty.as_ptr().cast::<libc::c_char>(),
            argv,
            environment,
            libc::AT_EMPTY_PATH,
        );
        child_fail(CHILD_STATUS_FD, ChildStage::Exec)
    }

    unsafe fn child_dup3(
        source: RawFd,
        target: RawFd,
        flags: libc::c_int,
        status_fd: RawFd,
        stage: ChildStage,
    ) {
        if libc::dup3(source, target, flags) != target {
            child_fail(status_fd, stage);
        }
    }

    unsafe fn child_fail(status_fd: RawFd, stage: ChildStage) -> ! {
        let errno = *libc::__errno_location();
        let record = child_failure_record(stage, errno);
        let mut written = 0usize;
        while written < record.len() {
            let result = libc::write(
                status_fd,
                record[written..].as_ptr().cast(),
                record.len() - written,
            );
            if result > 0 {
                written += result as usize;
            } else if result < 0 && *libc::__errno_location() == libc::EINTR {
                continue;
            } else {
                break;
            }
        }
        libc::_exit(127)
    }

    fn child_failure_record(stage: ChildStage, errno: libc::c_int) -> [u8; CHILD_FAILURE_BYTES] {
        let mut record = [0u8; CHILD_FAILURE_BYTES];
        record[..4].copy_from_slice(&CHILD_FAILURE_MAGIC);
        record[4] = CHILD_FAILURE_VERSION;
        record[5] = stage as u8;
        record[8..12].copy_from_slice(&errno.to_be_bytes());
        record
    }

    fn parse_child_failure_record(
        record: &[u8],
    ) -> Result<(ChildStage, libc::c_int), ClosedExecutionProcessError> {
        if record.len() != CHILD_FAILURE_BYTES
            || record[..4] != CHILD_FAILURE_MAGIC
            || record[4] != CHILD_FAILURE_VERSION
            || record[6] != 0
            || record[7] != 0
        {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_child_failure_record_invalid",
            ));
        }
        let stage = ChildStage::from_wire(record[5]).ok_or_else(|| {
            ClosedExecutionProcessError::new("closed_execution_child_failure_record_invalid")
        })?;
        let errno = libc::c_int::from_be_bytes(record[8..12].try_into().map_err(|_| {
            ClosedExecutionProcessError::new("closed_execution_child_failure_record_invalid")
        })?);
        if errno <= 0 {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_child_failure_record_invalid",
            ));
        }
        Ok((stage, errno))
    }

    fn child_failure_from_status(
        status: &OwnedFd,
        wait_status: libc::c_int,
    ) -> ClosedExecutionProcessError {
        if libc::WIFEXITED(wait_status) || libc::WIFSIGNALED(wait_status) {
            match read_child_failure(status.as_raw_fd()) {
                Ok((stage, errno)) => {
                    return ClosedExecutionProcessError::child(
                        stage.code(),
                        io::Error::from_raw_os_error(errno),
                    )
                }
                Err(error) => return error,
            }
        }
        ClosedExecutionProcessError::new("closed_execution_exec_event_not_observed")
    }

    fn read_child_failure(
        fd: RawFd,
    ) -> Result<(ChildStage, libc::c_int), ClosedExecutionProcessError> {
        let mut record = [0u8; CHILD_FAILURE_BYTES];
        let mut read = 0usize;
        while read < record.len() {
            let result =
                unsafe { libc::read(fd, record[read..].as_mut_ptr().cast(), record.len() - read) };
            if result > 0 {
                read += result as usize;
                continue;
            }
            if result == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_child_failure_read_failed",
                error,
            ));
        }
        if read == 0 {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_child_exited_without_failure_record",
            ));
        }
        parse_child_failure_record(&record[..read])
    }

    fn ptrace_set_exec_observation(pid: libc::pid_t) -> Result<(), ClosedExecutionProcessError> {
        let options = (libc::PTRACE_O_TRACEEXEC | libc::PTRACE_O_EXITKILL) as usize;
        let result = unsafe {
            libc::ptrace(
                libc::PTRACE_SETOPTIONS,
                pid,
                ptr::null_mut::<libc::c_void>(),
                options as *mut libc::c_void,
            )
        };
        if result != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_ptrace_options_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn ptrace_continue(pid: libc::pid_t) -> Result<(), ClosedExecutionProcessError> {
        let result = unsafe {
            libc::ptrace(
                libc::PTRACE_CONT,
                pid,
                ptr::null_mut::<libc::c_void>(),
                ptr::null_mut::<libc::c_void>(),
            )
        };
        if result != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_ptrace_continue_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn ptrace_detach(pid: libc::pid_t) -> Result<(), ClosedExecutionProcessError> {
        let result = unsafe {
            libc::ptrace(
                libc::PTRACE_DETACH,
                pid,
                ptr::null_mut::<libc::c_void>(),
                ptr::null_mut::<libc::c_void>(),
            )
        };
        if result != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_ptrace_detach_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn ptrace_exec_event(status: libc::c_int) -> bool {
        libc::WIFSTOPPED(status)
            && libc::WSTOPSIG(status) == libc::SIGTRAP
            && ((status as u32 >> 16) & 0xffff) == libc::PTRACE_EVENT_EXEC as u32
    }

    fn wait_for_child(pid: libc::pid_t) -> Result<libc::c_int, ClosedExecutionProcessError> {
        loop {
            let mut status = 0;
            let result = unsafe { libc::waitpid(pid, &mut status, 0) };
            if result == pid {
                return Ok(status);
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_waitpid_failed",
                error,
            ));
        }
    }

    fn child_was_reaped(status: libc::c_int) -> bool {
        libc::WIFEXITED(status) || libc::WIFSIGNALED(status)
    }

    fn decode_exit_status(
        status: libc::c_int,
    ) -> Result<(Option<i32>, Option<i32>), ClosedExecutionProcessError> {
        if libc::WIFEXITED(status) {
            return Ok((Some(libc::WEXITSTATUS(status)), None));
        }
        if libc::WIFSIGNALED(status) {
            return Ok((None, Some(libc::WTERMSIG(status))));
        }
        Err(ClosedExecutionProcessError::new(
            "closed_execution_leader_exit_status_invalid",
        ))
    }

    fn abort_spawn(
        mut process_set: CgroupProcessSet,
        pidfd: &OwnedFd,
        leader_pid: libc::pid_t,
        cleanup_deadline_monotonic_ns: u64,
        child_reaped: bool,
    ) {
        let _ = pidfd_send_signal(pidfd.as_raw_fd(), libc::SIGKILL);
        let _ = process_set.kill_and_remove_support_only(cleanup_deadline_monotonic_ns);
        if !child_reaped {
            let _ = wait_for_child(leader_pid);
        }
    }

    fn abort_spawn_with_watchdog(
        process_set: CgroupProcessSet,
        pidfd: &OwnedFd,
        leader_pid: libc::pid_t,
        cleanup_deadline_monotonic_ns: u64,
        child_reaped: bool,
        watchdog: &mut DeadlineWatchdog,
    ) {
        let _ = watchdog.cancel();
        abort_spawn(
            process_set,
            pidfd,
            leader_pid,
            cleanup_deadline_monotonic_ns,
            child_reaped,
        );
    }

    fn abort_spawn_without_pidfd(
        mut process_set: CgroupProcessSet,
        leader_pid: libc::pid_t,
        cleanup_deadline_monotonic_ns: u64,
    ) {
        let _ = process_set.kill_and_remove_support_only(cleanup_deadline_monotonic_ns);
        let _ = unsafe { libc::kill(leader_pid, libc::SIGKILL) };
        let _ = wait_for_child(leader_pid);
    }

    fn ensure_execution_identity_separated(
        credentials: ExecutionCredentials,
        supervisor_uid: libc::uid_t,
    ) -> Result<(), ClosedExecutionProcessError> {
        if credentials.uid == supervisor_uid {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_target_uid_not_separated_from_supervisor",
            ));
        }
        Ok(())
    }

    fn close_raw_fd_if_valid(fd: RawFd) {
        if fd >= 0 {
            let _ = unsafe { libc::close(fd) };
        }
    }

    fn pidfd_exit_observed(fd: RawFd) -> Result<bool, ClosedExecutionProcessError> {
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
        if result < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_leader_pidfd_poll_failed",
                io::Error::last_os_error(),
            ));
        }
        if result == 1 && descriptor.revents & (libc::POLLNVAL | libc::POLLERR) != 0 {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_leader_pidfd_poll_invalid",
            ));
        }
        Ok(result == 1 && descriptor.revents & libc::POLLIN != 0)
    }

    fn descriptor_identity(
        fd: &OwnedFd,
        requires_write: bool,
    ) -> Result<ClosedExecutionIdentity, ClosedExecutionProcessError> {
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_stdio_flags_unavailable",
                io::Error::last_os_error(),
            ));
        }
        let access = flags & libc::O_ACCMODE;
        if (requires_write && access == libc::O_RDONLY)
            || (!requires_write && access == libc::O_WRONLY)
        {
            return Err(ClosedExecutionProcessError::new(
                "closed_execution_stdio_access_invalid",
            ));
        }
        let stat = stat_fd(fd.as_raw_fd(), "closed_execution_stdio_stat_failed")?;
        Ok(hash_identity(
            STDIO_IDENTITY_DOMAIN,
            &[
                &(stat.st_dev as u64).to_be_bytes(),
                &(stat.st_ino as u64).to_be_bytes(),
                &stat.st_mode.to_be_bytes(),
                &flags.to_be_bytes(),
            ],
        ))
    }

    fn vector_identity(values: &[CString]) -> ClosedExecutionIdentity {
        let mut hasher = Sha256::new();
        hasher.update((VECTOR_IDENTITY_DOMAIN.len() as u64).to_be_bytes());
        hasher.update(VECTOR_IDENTITY_DOMAIN);
        hasher.update((values.len() as u64).to_be_bytes());
        for value in values {
            let bytes = value.as_bytes();
            hasher.update((bytes.len() as u64).to_be_bytes());
            hasher.update(bytes);
        }
        ClosedExecutionIdentity(hasher.finalize().into())
    }

    fn pointer_vector(values: &[CString]) -> Vec<*const libc::c_char> {
        values
            .iter()
            .map(|value| value.as_ptr())
            .chain(std::iter::once(ptr::null()))
            .collect()
    }

    fn hash_fd_bytes(
        fd: RawFd,
        expected_length: u64,
    ) -> Result<[u8; IDENTITY_BYTES], ClosedExecutionProcessError> {
        let mut hasher = Sha256::new();
        let mut offset = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        while offset < expected_length {
            let remaining = expected_length - offset;
            let requested = buffer.len().min(remaining as usize);
            let result = unsafe {
                libc::pread(
                    fd,
                    buffer.as_mut_ptr().cast(),
                    requested,
                    offset as libc::off_t,
                )
            };
            if result > 0 {
                let count = result as usize;
                hasher.update(&buffer[..count]);
                offset += count as u64;
                continue;
            }
            if result == 0 {
                return Err(ClosedExecutionProcessError::new(
                    "closed_execution_executable_read_truncated",
                ));
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_executable_read_failed",
                error,
            ));
        }
        Ok(hasher.finalize().into())
    }

    fn stat_fd(fd: RawFd, code: &'static str) -> Result<libc::stat, ClosedExecutionProcessError> {
        let mut stat = MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                code,
                io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { stat.assume_init() })
    }

    fn duplicate_fd_min(fd: RawFd) -> Result<OwnedFd, ClosedExecutionProcessError> {
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, CHILD_FD_FLOOR) };
        if duplicate < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_descriptor_duplicate_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
    }

    fn pipe_cloexec() -> Result<(OwnedFd, OwnedFd), ClosedExecutionProcessError> {
        let mut descriptors = [-1; 2];
        if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_status_pipe_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(unsafe {
            (
                OwnedFd::from_raw_fd(descriptors[0]),
                OwnedFd::from_raw_fd(descriptors[1]),
            )
        })
    }

    fn set_fd_cloexec(fd: RawFd) -> Result<(), ClosedExecutionProcessError> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_pidfd_cloexec_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn pidfd_process_id(fd: RawFd) -> Result<libc::pid_t, ClosedExecutionProcessError> {
        let fdinfo =
            std::fs::read_to_string(format!("/proc/self/fdinfo/{fd}")).map_err(|error| {
                ClosedExecutionProcessError::with_io(
                    "closed_execution_pidfd_identity_unavailable",
                    error,
                )
            })?;
        fdinfo
            .lines()
            .find_map(|line| line.strip_prefix("Pid:").map(str::trim))
            .and_then(|value| value.parse::<libc::pid_t>().ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(|| {
                ClosedExecutionProcessError::new("closed_execution_pidfd_identity_unavailable")
            })
    }

    fn pidfd_send_signal(fd: RawFd, signal: libc::c_int) -> io::Result<()> {
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd,
                signal,
                ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn create_absolute_timer(
        deadline_monotonic_ns: u64,
    ) -> Result<OwnedFd, ClosedExecutionProcessError> {
        let raw_fd = unsafe {
            libc::timerfd_create(
                libc::CLOCK_MONOTONIC,
                libc::TFD_CLOEXEC | libc::TFD_NONBLOCK,
            )
        };
        if raw_fd < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_watchdog_timer_failed",
                io::Error::last_os_error(),
            ));
        }
        let timer = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let specification = libc::itimerspec {
            it_interval: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
            it_value: libc::timespec {
                tv_sec: (deadline_monotonic_ns / 1_000_000_000) as libc::time_t,
                tv_nsec: (deadline_monotonic_ns % 1_000_000_000) as libc::c_long,
            },
        };
        if unsafe {
            libc::timerfd_settime(
                timer.as_raw_fd(),
                libc::TFD_TIMER_ABSTIME,
                &specification,
                ptr::null_mut(),
            )
        } != 0
        {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_watchdog_timer_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(timer)
    }

    fn create_eventfd() -> Result<OwnedFd, ClosedExecutionProcessError> {
        let raw_fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
        if raw_fd < 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_watchdog_cancel_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
    }

    fn write_eventfd(fd: RawFd) -> Result<(), ClosedExecutionProcessError> {
        let value = 1u64.to_ne_bytes();
        let written = unsafe { libc::write(fd, value.as_ptr().cast(), value.len()) };
        if written != value.len() as isize {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_watchdog_cancel_failed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn monotonic_now_ns() -> Result<u64, ClosedExecutionProcessError> {
        let mut timestamp = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut timestamp) } != 0 {
            return Err(ClosedExecutionProcessError::with_io(
                "closed_execution_monotonic_clock_unavailable",
                io::Error::last_os_error(),
            ));
        }
        let seconds = u64::try_from(timestamp.tv_sec).map_err(|_| {
            ClosedExecutionProcessError::new("closed_execution_monotonic_clock_invalid")
        })?;
        let nanoseconds = u64::try_from(timestamp.tv_nsec).map_err(|_| {
            ClosedExecutionProcessError::new("closed_execution_monotonic_clock_invalid")
        })?;
        seconds
            .checked_mul(1_000_000_000)
            .and_then(|value| value.checked_add(nanoseconds))
            .ok_or_else(|| {
                ClosedExecutionProcessError::new("closed_execution_monotonic_clock_invalid")
            })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs::File, io::Write};

        fn sealed_executable(bytes: &[u8]) -> SealedExecutable {
            let name = c"closed-execution-test";
            let raw_fd = unsafe {
                libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING)
            };
            assert!(raw_fd >= 0);
            let mut file = unsafe { File::from_raw_fd(raw_fd) };
            file.write_all(bytes).unwrap();
            assert_eq!(unsafe { libc::fchmod(file.as_raw_fd(), 0o555) }, 0);
            assert_eq!(
                unsafe {
                    libc::fcntl(
                        file.as_raw_fd(),
                        libc::F_ADD_SEALS,
                        REQUIRED_EXECUTABLE_SEALS,
                    )
                },
                0
            );
            let digest: [u8; IDENTITY_BYTES] = Sha256::digest(bytes).into();
            SealedExecutable::from_fd(file.into(), digest, bytes.len() as u64).unwrap()
        }

        fn working_directory() -> PinnedWorkingDirectory {
            let path = c"/";
            let raw_fd = unsafe {
                libc::open(
                    path.as_ptr(),
                    libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            };
            assert!(raw_fd >= 0);
            PinnedWorkingDirectory::from_fd(unsafe { OwnedFd::from_raw_fd(raw_fd) }).unwrap()
        }

        fn stdio() -> ClosedExecutionStdio {
            let open = |flags| {
                let raw_fd = unsafe { libc::open(c"/dev/null".as_ptr(), flags | libc::O_CLOEXEC) };
                assert!(raw_fd >= 0);
                unsafe { OwnedFd::from_raw_fd(raw_fd) }
            };
            ClosedExecutionStdio::new(
                open(libc::O_RDONLY),
                open(libc::O_WRONLY),
                open(libc::O_WRONLY),
            )
            .unwrap()
        }

        fn plan(argument: &str, environment_value: &str) -> ClosedExecutionSpawnPlan {
            ClosedExecutionSpawnPlan::new(
                sealed_executable(b"sealed executable bytes"),
                working_directory(),
                stdio(),
                ExecutionCredentials::unprivileged(65_534, 65_534).unwrap(),
                vec![OsString::from(argument)],
                vec![(OsString::from("VALUE"), OsString::from(environment_value))],
                0o077,
                SpawnInputLimits::new(8, 8, 4096).unwrap(),
            )
            .unwrap()
        }

        #[test]
        fn spawn_plan_identity_binds_arguments_and_environment() {
            assert_ne!(
                plan("first", "one").identity(),
                plan("second", "one").identity()
            );
            assert_ne!(
                plan("first", "one").identity(),
                plan("first", "two").identity()
            );
        }

        #[test]
        fn process_set_seed_must_bind_the_exact_spawn_plan() {
            let first = plan("first", "one");
            let second = plan("second", "one");
            let identity = [3; IDENTITY_BYTES];

            ensure_process_set_bound_to_plan(
                first.process_set_seed().unwrap(),
                &identity,
                &identity,
                &first,
            )
            .unwrap();
            assert_eq!(
                ensure_process_set_bound_to_plan(
                    first.process_set_seed().unwrap(),
                    &identity,
                    &identity,
                    &second,
                )
                .unwrap_err()
                .code(),
                "closed_execution_process_set_spawn_plan_mismatch"
            );
        }

        #[test]
        fn process_set_identity_must_match_the_authorized_leaf() {
            let plan = plan("first", "one");
            assert_eq!(
                ensure_process_set_bound_to_plan(
                    plan.process_set_seed().unwrap(),
                    &[3; IDENTITY_BYTES],
                    &[4; IDENTITY_BYTES],
                    &plan,
                )
                .unwrap_err()
                .code(),
                "closed_execution_process_set_identity_mismatch"
            );
        }

        #[test]
        fn environment_is_canonical_and_duplicate_keys_are_refused() {
            let executable = sealed_executable(b"sealed executable bytes");
            let error = ClosedExecutionSpawnPlan::new(
                executable,
                working_directory(),
                stdio(),
                ExecutionCredentials::unprivileged(65_534, 65_534).unwrap(),
                vec![OsString::from("program")],
                vec![
                    (OsString::from("KEY"), OsString::from("one")),
                    (OsString::from("KEY"), OsString::from("two")),
                ],
                0o077,
                SpawnInputLimits::new(8, 8, 4096).unwrap(),
            )
            .unwrap_err();
            assert_eq!(error.code(), "closed_execution_environment_key_duplicate");
        }

        #[test]
        fn unsealed_executable_is_refused() {
            let file = tempfile::tempfile().unwrap();
            let bytes = b"not sealed";
            (&file).write_all(bytes).unwrap();
            assert_eq!(unsafe { libc::fchmod(file.as_raw_fd(), 0o555) }, 0);
            let digest: [u8; IDENTITY_BYTES] = Sha256::digest(bytes).into();
            assert_eq!(
                SealedExecutable::from_fd(file.into(), digest, bytes.len() as u64)
                    .unwrap_err()
                    .code(),
                "closed_execution_executable_seals_missing"
            );
        }

        #[test]
        fn clone_arguments_require_atomic_cgroup_and_pidfd_creation() {
            let mut pidfd = -1;
            let arguments = clone_arguments(&mut pidfd, 17);
            assert_eq!(arguments.flags, LINUX_CLONE_PIDFD | LINUX_CLONE_INTO_CGROUP);
            assert_eq!(arguments.exit_signal, libc::SIGCHLD as u64);
            assert_eq!(arguments.cgroup, 17);
            assert_eq!(
                arguments.pidfd,
                (&mut pidfd as *mut libc::c_int) as usize as u64
            );
        }

        #[test]
        fn child_failure_records_are_canonical() {
            let record = child_failure_record(ChildStage::Exec, libc::ENOEXEC);
            assert_eq!(
                parse_child_failure_record(&record).unwrap(),
                (ChildStage::Exec, libc::ENOEXEC)
            );
            let mut forged = record;
            forged[6] = 1;
            assert_eq!(
                parse_child_failure_record(&forged).unwrap_err().code(),
                "closed_execution_child_failure_record_invalid"
            );
        }

        #[test]
        fn privileged_execution_identity_is_refused() {
            assert_eq!(
                ExecutionCredentials::unprivileged(0, 1).unwrap_err().code(),
                "closed_execution_privileged_target_identity_refused"
            );
            assert_eq!(
                ExecutionCredentials::unprivileged(1, 0).unwrap_err().code(),
                "closed_execution_privileged_target_identity_refused"
            );
        }

        #[test]
        fn target_identity_must_differ_from_supervisor_identity() {
            let credentials = ExecutionCredentials::unprivileged(1_234, 1_234).unwrap();
            assert_eq!(
                ensure_execution_identity_separated(credentials, 1_234)
                    .unwrap_err()
                    .code(),
                "closed_execution_target_uid_not_separated_from_supervisor"
            );
            ensure_execution_identity_separated(credentials, 4_321).unwrap();
        }

        #[test]
        fn watchdog_prefers_observed_exit_or_cancel_over_deadline() {
            assert!(!watchdog_poll_should_fire(2, 0, libc::POLLIN));
            assert!(!watchdog_poll_should_fire(2, libc::POLLIN, 0));
            assert!(watchdog_poll_should_fire(1, 0, 0));
            assert!(watchdog_poll_should_fire(-1, 0, 0));
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{
    spawn_atomic_process, AtomicContainedProcess, AtomicProcessCompletion, AtomicSpawnObservation,
    ClosedExecutionSpawnPlan, ClosedExecutionStdio, ExecutionCredentials, PinnedWorkingDirectory,
    SealedExecutable, SpawnInputLimits,
};

#[cfg(test)]
mod common_tests {
    use super::*;

    #[test]
    fn process_observation_is_never_hmr_authority() {
        assert_eq!(
            CLOSED_EXECUTION_PROCESS_SCHEMA,
            "synthi.closed_execution.atomic_process_observation.v1"
        );
        assert!(CLOSED_EXECUTION_PROCESS_EVIDENCE_AUTHORITY
            .ends_with("not_closed_execution_or_gpu_hmr_acceptance"));
    }
}
