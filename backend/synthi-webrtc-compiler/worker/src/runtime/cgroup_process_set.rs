use sha2::{Digest, Sha256};
use std::{fmt, io, path::Path};

pub const CGROUP_PROCESS_SET_SCHEMA: &str = "synthi.closed_execution.cgroup_process_set.v1";
pub const CGROUP_PROCESS_SET_EVIDENCE_AUTHORITY: &str =
    "kernel_process_set_lifecycle_only_not_gpu_hmr_acceptance";

const IDENTITY_BYTES: usize = 32;
const ROOT_IDENTITY_DOMAIN: &[u8] = b"synthi.closed_execution.cgroup_root.v1";
const LEAF_NAME_DOMAIN: &[u8] = b"synthi.closed_execution.cgroup_leaf_name.v1";
const PROCESS_SET_IDENTITY_DOMAIN: &[u8] =
    b"synthi.closed_execution.cgroup_process_set_identity.v1";

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcessSetSeed([u8; IDENTITY_BYTES]);

impl ProcessSetSeed {
    pub fn from_content_digest(
        digest: [u8; IDENTITY_BYTES],
    ) -> Result<Self, CgroupProcessSetError> {
        if digest == [0; IDENTITY_BYTES] {
            return Err(CgroupProcessSetError::new(
                "cgroup_process_set_seed_invalid",
            ));
        }
        Ok(Self(digest))
    }

    pub fn as_bytes(&self) -> &[u8; IDENTITY_BYTES] {
        &self.0
    }
}

impl fmt::Debug for ProcessSetSeed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProcessSetSeed")
            .field(&hex::encode(self.0))
            .finish()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct KernelCgroupIdentity([u8; IDENTITY_BYTES]);

impl KernelCgroupIdentity {
    pub fn as_bytes(&self) -> &[u8; IDENTITY_BYTES] {
        &self.0
    }
}

impl fmt::Debug for KernelCgroupIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("KernelCgroupIdentity")
            .field(&hex::encode(self.0))
            .finish()
    }
}

#[derive(Debug)]
pub struct CgroupProcessSetError {
    code: &'static str,
    source: Option<io::Error>,
}

impl CgroupProcessSetError {
    fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    fn with_io(code: &'static str, source: io::Error) -> Self {
        Self {
            code,
            source: Some(source),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for CgroupProcessSetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for CgroupProcessSetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

fn hash_identity(domain: &[u8], fields: &[&[u8]]) -> KernelCgroupIdentity {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    KernelCgroupIdentity(hasher.finalize().into())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use ring::rand::{SecureRandom, SystemRandom};
    use std::{
        ffi::{CStr, CString},
        mem::MaybeUninit,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
            unix::ffi::OsStrExt,
        },
        path::Component,
        sync::Arc,
    };

    const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;
    const MAX_CONTROL_BYTES: usize = 64 * 1024;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CgroupRootObservation {
        kernel_identity: KernelCgroupIdentity,
        mount_namespace_device: u64,
        mount_namespace_inode: u64,
        filesystem_device: u64,
        directory_inode: u64,
        owner_uid: u32,
        owner_gid: u32,
        mode: u32,
        controls_owned_by_effective_uid: bool,
        group_or_other_writable: bool,
        domain_type_observed: bool,
    }

    impl CgroupRootObservation {
        pub fn kernel_identity(&self) -> KernelCgroupIdentity {
            self.kernel_identity
        }

        pub fn controls_owned_by_effective_uid(&self) -> bool {
            self.controls_owned_by_effective_uid
        }

        pub fn group_or_other_writable(&self) -> bool {
            self.group_or_other_writable
        }

        pub fn domain_type_observed(&self) -> bool {
            self.domain_type_observed
        }
    }

    pub struct CgroupV2ProcessSetRoot {
        root: Arc<OwnedFd>,
        observation: CgroupRootObservation,
    }

    impl CgroupV2ProcessSetRoot {
        /// Opens a supervisor-configured cgroup-v2 root. Request payloads must
        /// never select this path. The returned FD remains pinned for the
        /// supervisor lifetime, so later path replacement cannot retarget it.
        pub fn open_configured_root(path: &Path) -> Result<Self, CgroupProcessSetError> {
            let root = open_absolute_directory_without_links(path)?;
            require_cgroup_v2(root.as_raw_fd(), "cgroup_process_set_root_not_cgroup_v2")?;
            require_domain_cgroup(root.as_raw_fd(), "cgroup_process_set_root_not_domain")?;
            let root_stat = stat_fd(root.as_raw_fd(), "cgroup_process_set_root_stat_failed")?;
            let mount_namespace = open_path(c"/proc/self/ns/mnt", libc::O_PATH | libc::O_CLOEXEC)
                .map_err(|error| {
                CgroupProcessSetError::with_io(
                    "cgroup_process_set_mount_namespace_unavailable",
                    error,
                )
            })?;
            let mount_stat = stat_fd(
                mount_namespace.as_raw_fd(),
                "cgroup_process_set_mount_namespace_unavailable",
            )?;
            let procs = open_control(root.as_raw_fd(), c"cgroup.procs", libc::O_WRONLY).map_err(
                |error| {
                    CgroupProcessSetError::with_io(
                        "cgroup_process_set_root_controls_unavailable",
                        error,
                    )
                },
            )?;
            open_control(root.as_raw_fd(), c"cgroup.controllers", libc::O_RDONLY).map_err(
                |error| {
                    CgroupProcessSetError::with_io(
                        "cgroup_process_set_root_controls_unavailable",
                        error,
                    )
                },
            )?;
            open_control(root.as_raw_fd(), c"cgroup.subtree_control", libc::O_RDONLY).map_err(
                |error| {
                    CgroupProcessSetError::with_io(
                        "cgroup_process_set_root_controls_unavailable",
                        error,
                    )
                },
            )?;
            let procs_stat = stat_fd(
                procs.as_raw_fd(),
                "cgroup_process_set_root_controls_unavailable",
            )?;
            let effective_uid = unsafe { libc::geteuid() };
            let controls_owned_by_effective_uid =
                root_stat.st_uid == effective_uid && procs_stat.st_uid == effective_uid;
            let group_or_other_writable =
                root_stat.st_mode & 0o022 != 0 || procs_stat.st_mode & 0o022 != 0;
            if !controls_owned_by_effective_uid {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_root_not_effective_uid_owned",
                ));
            }
            if group_or_other_writable {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_root_write_authority_too_broad",
                ));
            }

            let mount_namespace_device = mount_stat.st_dev as u64;
            let mount_namespace_inode = mount_stat.st_ino as u64;
            let filesystem_device = root_stat.st_dev as u64;
            let directory_inode = root_stat.st_ino as u64;
            let owner_uid = root_stat.st_uid;
            let owner_gid = root_stat.st_gid;
            let mode = root_stat.st_mode;
            let kernel_identity = hash_identity(
                ROOT_IDENTITY_DOMAIN,
                &[
                    &mount_namespace_device.to_be_bytes(),
                    &mount_namespace_inode.to_be_bytes(),
                    &filesystem_device.to_be_bytes(),
                    &directory_inode.to_be_bytes(),
                    &owner_uid.to_be_bytes(),
                    &owner_gid.to_be_bytes(),
                    &mode.to_be_bytes(),
                ],
            );
            Ok(Self {
                root: Arc::new(root),
                observation: CgroupRootObservation {
                    kernel_identity,
                    mount_namespace_device,
                    mount_namespace_inode,
                    filesystem_device,
                    directory_inode,
                    owner_uid,
                    owner_gid,
                    mode,
                    controls_owned_by_effective_uid,
                    group_or_other_writable,
                    domain_type_observed: true,
                },
            })
        }

        pub fn observation(&self) -> &CgroupRootObservation {
            &self.observation
        }

        pub fn create_process_set(
            &self,
            seed: ProcessSetSeed,
        ) -> Result<CgroupProcessSet, CgroupProcessSetError> {
            let nonce = random_nonce()?;
            self.create_process_set_with_nonce(seed, nonce)
        }

        fn create_process_set_with_nonce(
            &self,
            seed: ProcessSetSeed,
            nonce: [u8; IDENTITY_BYTES],
        ) -> Result<CgroupProcessSet, CgroupProcessSetError> {
            if nonce == [0; IDENTITY_BYTES] {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_nonce_invalid",
                ));
            }
            let created_monotonic_ns = kernel_monotonic_now_ns().map_err(|error| {
                CgroupProcessSetError::with_io(
                    "cgroup_process_set_monotonic_clock_unavailable",
                    error,
                )
            })?;
            let leaf_digest = hash_identity(
                LEAF_NAME_DOMAIN,
                &[
                    self.observation.kernel_identity.as_bytes(),
                    seed.as_bytes(),
                    &nonce,
                ],
            );
            let leaf_name = format!("exec-{}", hex::encode(leaf_digest.as_bytes()));
            let leaf_name_c = CString::new(leaf_name.as_bytes())
                .map_err(|_| CgroupProcessSetError::new("cgroup_process_set_leaf_name_invalid"))?;
            if unsafe { libc::mkdirat(self.root.as_raw_fd(), leaf_name_c.as_ptr(), 0o700) } != 0 {
                return Err(CgroupProcessSetError::with_io(
                    "cgroup_process_set_leaf_create_failed",
                    io::Error::last_os_error(),
                ));
            }

            let leaf = match open_beneath(
                self.root.as_raw_fd(),
                &leaf_name_c,
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
            ) {
                Ok(leaf) => leaf,
                Err(error) => {
                    let _ = remove_leaf(self.root.as_raw_fd(), &leaf_name_c);
                    return Err(CgroupProcessSetError::with_io(
                        "cgroup_process_set_leaf_open_failed",
                        error,
                    ));
                }
            };
            let guard = LeafGuard::new(self.root.clone(), leaf, leaf_name_c)?;
            require_domain_cgroup(guard.leaf.as_raw_fd(), "cgroup_process_set_leaf_not_domain")?;
            if guard.populated()? {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_leaf_not_empty_at_creation",
                ));
            }
            let leaf_stat = stat_fd(
                guard.leaf.as_raw_fd(),
                "cgroup_process_set_leaf_stat_failed",
            )?;
            let effective_uid = unsafe { libc::geteuid() };
            if leaf_stat.st_uid != effective_uid || leaf_stat.st_mode & 0o022 != 0 {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_leaf_write_authority_invalid",
                ));
            }
            let filesystem_device = leaf_stat.st_dev as u64;
            let directory_inode = leaf_stat.st_ino as u64;
            let owner_uid = leaf_stat.st_uid;
            let owner_gid = leaf_stat.st_gid;
            let mode = leaf_stat.st_mode;
            let process_set_identity = hash_identity(
                PROCESS_SET_IDENTITY_DOMAIN,
                &[
                    self.observation.kernel_identity.as_bytes(),
                    seed.as_bytes(),
                    &nonce,
                    &filesystem_device.to_be_bytes(),
                    &directory_inode.to_be_bytes(),
                    &owner_uid.to_be_bytes(),
                    &owner_gid.to_be_bytes(),
                    &mode.to_be_bytes(),
                ],
            );
            let observation = CgroupProcessSetObservation {
                root_identity: self.observation.kernel_identity,
                process_set_identity,
                seed,
                nonce,
                leaf_name,
                filesystem_device,
                directory_inode,
                owner_uid,
                owner_gid,
                mode,
                created_monotonic_ns,
                initially_unpopulated: true,
                domain_type_observed: true,
                clone_into_cgroup_required: true,
                clone_pidfd_required: true,
            };
            Ok(CgroupProcessSet {
                observation,
                guard: Some(guard),
            })
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CgroupProcessSetObservation {
        root_identity: KernelCgroupIdentity,
        process_set_identity: KernelCgroupIdentity,
        seed: ProcessSetSeed,
        nonce: [u8; IDENTITY_BYTES],
        leaf_name: String,
        filesystem_device: u64,
        directory_inode: u64,
        owner_uid: u32,
        owner_gid: u32,
        mode: u32,
        created_monotonic_ns: u64,
        initially_unpopulated: bool,
        domain_type_observed: bool,
        clone_into_cgroup_required: bool,
        clone_pidfd_required: bool,
    }

    impl CgroupProcessSetObservation {
        pub fn root_identity(&self) -> KernelCgroupIdentity {
            self.root_identity
        }

        pub fn process_set_identity(&self) -> KernelCgroupIdentity {
            self.process_set_identity
        }

        pub fn seed(&self) -> ProcessSetSeed {
            self.seed
        }

        pub fn created_monotonic_ns(&self) -> u64 {
            self.created_monotonic_ns
        }

        pub fn initially_unpopulated(&self) -> bool {
            self.initially_unpopulated
        }

        pub fn domain_type_observed(&self) -> bool {
            self.domain_type_observed
        }

        pub fn clone_into_cgroup_required(&self) -> bool {
            self.clone_into_cgroup_required
        }

        pub fn clone_pidfd_required(&self) -> bool {
            self.clone_pidfd_required
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CgroupMembershipSnapshot {
        process_set_identity: KernelCgroupIdentity,
        pids: Vec<u32>,
        duplicate_pid_observed: bool,
        observed_monotonic_ns: u64,
    }

    impl CgroupMembershipSnapshot {
        pub fn process_set_identity(&self) -> KernelCgroupIdentity {
            self.process_set_identity
        }

        pub fn pids(&self) -> &[u32] {
            &self.pids
        }

        pub fn duplicate_pid_observed(&self) -> bool {
            self.duplicate_pid_observed
        }

        pub fn observed_monotonic_ns(&self) -> u64 {
            self.observed_monotonic_ns
        }
    }

    pub struct CgroupProcessSet {
        observation: CgroupProcessSetObservation,
        guard: Option<LeafGuard>,
    }

    impl CgroupProcessSet {
        pub fn observation(&self) -> &CgroupProcessSetObservation {
            &self.observation
        }

        /// This descriptor is only a clone target. Possessing it is not proof
        /// that a process was created in the cgroup.
        pub(crate) fn clone_target_fd(&self) -> Result<OwnedFd, CgroupProcessSetError> {
            let guard = self.guard.as_ref().ok_or_else(|| {
                CgroupProcessSetError::new("cgroup_process_set_already_cleaned_up")
            })?;
            duplicate_fd(guard.leaf.as_raw_fd()).map_err(|error| {
                CgroupProcessSetError::with_io("cgroup_process_set_clone_target_unavailable", error)
            })
        }

        pub fn membership_snapshot(
            &self,
        ) -> Result<CgroupMembershipSnapshot, CgroupProcessSetError> {
            self.guard
                .as_ref()
                .ok_or_else(|| CgroupProcessSetError::new("cgroup_process_set_already_cleaned_up"))?
                .membership_snapshot(self.observation.process_set_identity)
        }

        /// Kills processes still present in this cgroup and removes the leaf.
        /// This cleanup is support evidence only: without pidfd lineage and
        /// migration protection it cannot prove that every spawned process
        /// terminated or remained in the process set.
        pub fn kill_and_remove_support_only(
            &mut self,
            deadline_monotonic_ns: u64,
        ) -> Result<CgroupProcessSetCleanup, CgroupProcessSetError> {
            let mut guard = self.guard.take().ok_or_else(|| {
                CgroupProcessSetError::new("cgroup_process_set_already_cleaned_up")
            })?;
            let membership_before_kill =
                match guard.membership_snapshot(self.observation.process_set_identity) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        self.guard = Some(guard);
                        return Err(error);
                    }
                };
            if membership_before_kill.duplicate_pid_observed {
                self.guard = Some(guard);
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_membership_snapshot_ambiguous",
                ));
            }
            let kill_issued_monotonic_ns = match guard.issue_kill() {
                Ok(timestamp) => timestamp,
                Err(error) => {
                    self.guard = Some(guard);
                    return Err(error);
                }
            };
            let quiescent_monotonic_ns = match guard.wait_quiescent(deadline_monotonic_ns) {
                Ok(timestamp) => timestamp,
                Err(error) => {
                    self.guard = Some(guard);
                    return Err(error);
                }
            };
            let membership_after_quiescence =
                match guard.membership_snapshot(self.observation.process_set_identity) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        self.guard = Some(guard);
                        return Err(error);
                    }
                };
            if membership_after_quiescence.duplicate_pid_observed {
                self.guard = Some(guard);
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_membership_snapshot_ambiguous",
                ));
            }
            if !membership_after_quiescence.pids.is_empty() {
                self.guard = Some(guard);
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_members_remain_after_quiescence",
                ));
            }
            if kill_issued_monotonic_ns < self.observation.created_monotonic_ns
                || quiescent_monotonic_ns < kill_issued_monotonic_ns
                || membership_before_kill.observed_monotonic_ns
                    < self.observation.created_monotonic_ns
                || membership_after_quiescence.observed_monotonic_ns < quiescent_monotonic_ns
            {
                self.guard = Some(guard);
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_timing_order_invalid",
                ));
            }
            if let Err(error) = guard.remove() {
                self.guard = Some(guard);
                return Err(error);
            }
            Ok(CgroupProcessSetCleanup {
                process_set_identity: self.observation.process_set_identity,
                membership_before_kill,
                membership_after_quiescence,
                kill_issued_monotonic_ns,
                quiescent_monotonic_ns,
                process_set_kill_issued: true,
                leaf_unpopulated_after_kill: true,
                leaf_removed: true,
                migration_protection_observed: false,
                process_termination_proven: false,
            })
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CgroupProcessSetCleanup {
        process_set_identity: KernelCgroupIdentity,
        membership_before_kill: CgroupMembershipSnapshot,
        membership_after_quiescence: CgroupMembershipSnapshot,
        kill_issued_monotonic_ns: u64,
        quiescent_monotonic_ns: u64,
        process_set_kill_issued: bool,
        leaf_unpopulated_after_kill: bool,
        leaf_removed: bool,
        migration_protection_observed: bool,
        process_termination_proven: bool,
    }

    impl CgroupProcessSetCleanup {
        pub fn process_set_identity(&self) -> KernelCgroupIdentity {
            self.process_set_identity
        }

        pub fn membership_before_kill(&self) -> &CgroupMembershipSnapshot {
            &self.membership_before_kill
        }

        pub fn membership_after_quiescence(&self) -> &CgroupMembershipSnapshot {
            &self.membership_after_quiescence
        }

        pub fn kill_issued_monotonic_ns(&self) -> u64 {
            self.kill_issued_monotonic_ns
        }

        pub fn quiescent_monotonic_ns(&self) -> u64 {
            self.quiescent_monotonic_ns
        }

        pub fn process_set_kill_issued(&self) -> bool {
            self.process_set_kill_issued
        }

        pub fn leaf_unpopulated_after_kill(&self) -> bool {
            self.leaf_unpopulated_after_kill
        }

        pub fn leaf_removed(&self) -> bool {
            self.leaf_removed
        }

        pub fn migration_protection_observed(&self) -> bool {
            self.migration_protection_observed
        }

        pub fn process_termination_proven(&self) -> bool {
            self.process_termination_proven
        }
    }

    struct LeafControls {
        procs: OwnedFd,
        events: OwnedFd,
        kill: OwnedFd,
    }

    impl LeafControls {
        fn open(leaf: RawFd) -> Result<Self, CgroupProcessSetError> {
            let open = |name: &CStr, flags| {
                open_control(leaf, name, flags).map_err(|error| {
                    CgroupProcessSetError::with_io(
                        "cgroup_process_set_leaf_controls_unavailable",
                        error,
                    )
                })
            };
            let procs = open(c"cgroup.procs", libc::O_RDONLY)?;
            let events = open(c"cgroup.events", libc::O_RDONLY)?;
            let kill = open(c"cgroup.kill", libc::O_WRONLY)?;
            let effective_uid = unsafe { libc::geteuid() };
            for fd in [&procs, &events, &kill] {
                let stat = stat_fd(
                    fd.as_raw_fd(),
                    "cgroup_process_set_leaf_controls_unavailable",
                )?;
                if stat.st_uid != effective_uid || stat.st_mode & 0o022 != 0 {
                    return Err(CgroupProcessSetError::new(
                        "cgroup_process_set_leaf_control_authority_invalid",
                    ));
                }
            }
            Ok(Self {
                procs,
                events,
                kill,
            })
        }
    }

    struct LeafGuard {
        root: Arc<OwnedFd>,
        leaf: OwnedFd,
        leaf_name: CString,
        controls: LeafControls,
        armed: bool,
    }

    impl LeafGuard {
        fn new(
            root: Arc<OwnedFd>,
            leaf: OwnedFd,
            leaf_name: CString,
        ) -> Result<Self, CgroupProcessSetError> {
            let controls = match LeafControls::open(leaf.as_raw_fd()) {
                Ok(controls) => controls,
                Err(error) => {
                    let _ = remove_leaf(root.as_raw_fd(), &leaf_name);
                    return Err(error);
                }
            };
            Ok(Self {
                root,
                leaf,
                leaf_name,
                controls,
                armed: true,
            })
        }

        fn populated(&self) -> Result<bool, CgroupProcessSetError> {
            let bytes = read_control(self.controls.events.as_raw_fd()).map_err(|error| {
                CgroupProcessSetError::with_io("cgroup_process_set_events_read_failed", error)
            })?;
            parse_populated(&bytes)
        }

        fn membership_snapshot(
            &self,
            process_set_identity: KernelCgroupIdentity,
        ) -> Result<CgroupMembershipSnapshot, CgroupProcessSetError> {
            let bytes = read_control(self.controls.procs.as_raw_fd()).map_err(|error| {
                CgroupProcessSetError::with_io("cgroup_process_set_membership_read_failed", error)
            })?;
            let membership = parse_member_pids(&bytes)?;
            let observed_monotonic_ns = kernel_monotonic_now_ns().map_err(|error| {
                CgroupProcessSetError::with_io(
                    "cgroup_process_set_monotonic_clock_unavailable",
                    error,
                )
            })?;
            Ok(CgroupMembershipSnapshot {
                process_set_identity,
                pids: membership.pids,
                duplicate_pid_observed: membership.duplicate_pid_observed,
                observed_monotonic_ns,
            })
        }

        fn issue_kill(&self) -> Result<u64, CgroupProcessSetError> {
            write_all_fd(self.controls.kill.as_raw_fd(), b"1").map_err(|error| {
                CgroupProcessSetError::with_io("cgroup_process_set_kill_failed", error)
            })?;
            kernel_monotonic_now_ns().map_err(|error| {
                CgroupProcessSetError::with_io(
                    "cgroup_process_set_monotonic_clock_unavailable",
                    error,
                )
            })
        }

        fn wait_quiescent(&self, deadline_monotonic_ns: u64) -> Result<u64, CgroupProcessSetError> {
            loop {
                let now = kernel_monotonic_now_ns().map_err(|error| {
                    CgroupProcessSetError::with_io(
                        "cgroup_process_set_monotonic_clock_unavailable",
                        error,
                    )
                })?;
                if !self.populated()? {
                    return Ok(now);
                }
                if now >= deadline_monotonic_ns {
                    return Err(CgroupProcessSetError::new(
                        "cgroup_process_set_quiescence_deadline_reached",
                    ));
                }
                poll_for_control_change(self.controls.events.as_raw_fd(), deadline_monotonic_ns)?;
            }
        }

        fn remove(&mut self) -> Result<(), CgroupProcessSetError> {
            if self.populated()? {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_remove_while_populated",
                ));
            }
            remove_leaf(self.root.as_raw_fd(), &self.leaf_name).map_err(|error| {
                CgroupProcessSetError::with_io("cgroup_process_set_cleanup_failed", error)
            })?;
            self.armed = false;
            Ok(())
        }
    }

    impl Drop for LeafGuard {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            // This is fail-safe resource cleanup only. It is intentionally
            // unreported and must never count as lifecycle or termination
            // evidence; callers need the explicit cleanup path for that.
            let _ = write_all_fd(self.controls.kill.as_raw_fd(), b"1");
            if self.populated().ok() == Some(false)
                && remove_leaf(self.root.as_raw_fd(), &self.leaf_name).is_ok()
            {
                self.armed = false;
            }
        }
    }

    fn random_nonce() -> Result<[u8; IDENTITY_BYTES], CgroupProcessSetError> {
        for _ in 0..4 {
            let mut nonce = [0u8; IDENTITY_BYTES];
            SystemRandom::new().fill(&mut nonce).map_err(|_| {
                CgroupProcessSetError::new("cgroup_process_set_randomness_unavailable")
            })?;
            if nonce != [0; IDENTITY_BYTES] {
                return Ok(nonce);
            }
        }
        Err(CgroupProcessSetError::new(
            "cgroup_process_set_randomness_unavailable",
        ))
    }

    fn normalized_absolute_relative(path: &Path) -> Result<CString, CgroupProcessSetError> {
        if !path.is_absolute() {
            return Err(CgroupProcessSetError::new(
                "cgroup_process_set_root_path_not_absolute",
            ));
        }
        let mut bytes = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(value) => {
                    if !bytes.is_empty() {
                        bytes.push(b'/');
                    }
                    let value = value.as_bytes();
                    if value.is_empty() || value.contains(&0) {
                        return Err(CgroupProcessSetError::new(
                            "cgroup_process_set_root_path_invalid",
                        ));
                    }
                    bytes.extend_from_slice(value);
                }
                _ => {
                    return Err(CgroupProcessSetError::new(
                        "cgroup_process_set_root_path_invalid",
                    ))
                }
            }
        }
        if bytes.is_empty() {
            return Err(CgroupProcessSetError::new(
                "cgroup_process_set_root_path_invalid",
            ));
        }
        CString::new(bytes)
            .map_err(|_| CgroupProcessSetError::new("cgroup_process_set_root_path_invalid"))
    }

    fn open_absolute_directory_without_links(
        path: &Path,
    ) -> Result<OwnedFd, CgroupProcessSetError> {
        let relative = normalized_absolute_relative(path)?;
        let root = open_path(
            c"/",
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
        .map_err(|error| {
            CgroupProcessSetError::with_io("cgroup_process_set_root_anchor_open_failed", error)
        })?;
        open_beneath(
            root.as_raw_fd(),
            &relative,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
        .map_err(|error| {
            let code = if error.raw_os_error() == Some(libc::ENOSYS) {
                "cgroup_process_set_safe_resolution_unavailable"
            } else {
                "cgroup_process_set_root_open_failed"
            };
            CgroupProcessSetError::with_io(code, error)
        })
    }

    fn open_path(path: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        let raw_fd = unsafe { libc::open(path.as_ptr(), flags) };
        if raw_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(raw_fd) })
    }

    fn open_control(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        open_beneath(dir, name, flags | libc::O_CLOEXEC | libc::O_NOCTTY)
    }

    fn open_beneath(dir: RawFd, path: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        let how = OpenHow {
            flags: flags as u64,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
        };
        let raw_fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                dir,
                path.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if raw_fd < 0 || raw_fd > RawFd::MAX as libc::c_long {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(raw_fd as RawFd) })
    }

    fn require_cgroup_v2(fd: RawFd, code: &'static str) -> Result<(), CgroupProcessSetError> {
        let mut stats = MaybeUninit::<libc::statfs>::zeroed();
        if unsafe { libc::fstatfs(fd, stats.as_mut_ptr()) } != 0 {
            return Err(CgroupProcessSetError::with_io(
                code,
                io::Error::last_os_error(),
            ));
        }
        let stats = unsafe { stats.assume_init() };
        if stats.f_type != CGROUP2_SUPER_MAGIC {
            return Err(CgroupProcessSetError::new(code));
        }
        Ok(())
    }

    fn require_domain_cgroup(fd: RawFd, code: &'static str) -> Result<(), CgroupProcessSetError> {
        let cgroup_type = open_control(fd, c"cgroup.type", libc::O_RDONLY)
            .map_err(|error| CgroupProcessSetError::with_io(code, error))?;
        let bytes = read_control(cgroup_type.as_raw_fd())
            .map_err(|error| CgroupProcessSetError::with_io(code, error))?;
        if bytes == b"domain" || bytes == b"domain\n" {
            return Ok(());
        }
        Err(CgroupProcessSetError::new(code))
    }

    fn stat_fd(fd: RawFd, code: &'static str) -> Result<libc::stat, CgroupProcessSetError> {
        let mut stat = MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(CgroupProcessSetError::with_io(
                code,
                io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { stat.assume_init() })
    }

    fn duplicate_fd(fd: RawFd) -> io::Result<OwnedFd> {
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
    }

    fn write_all_fd(fd: RawFd, bytes: &[u8]) -> io::Result<()> {
        let mut written = 0usize;
        while written < bytes.len() {
            let result =
                unsafe { libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written) };
            if result > 0 {
                written += result as usize;
                continue;
            }
            if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(if result == 0 {
                io::Error::from_raw_os_error(libc::EIO)
            } else {
                io::Error::last_os_error()
            });
        }
        Ok(())
    }

    fn read_control(fd: RawFd) -> io::Result<Vec<u8>> {
        if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut bytes = Vec::with_capacity(256);
        let mut chunk = [0u8; 512];
        loop {
            let result = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
            if result > 0 {
                let count = result as usize;
                if bytes.len().saturating_add(count) > MAX_CONTROL_BYTES {
                    return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
                }
                bytes.extend_from_slice(&chunk[..count]);
                continue;
            }
            if result == 0 {
                return Ok(bytes);
            }
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(io::Error::last_os_error());
        }
    }

    fn poll_for_control_change(
        fd: RawFd,
        deadline_monotonic_ns: u64,
    ) -> Result<(), CgroupProcessSetError> {
        loop {
            let now = kernel_monotonic_now_ns().map_err(|error| {
                CgroupProcessSetError::with_io(
                    "cgroup_process_set_monotonic_clock_unavailable",
                    error,
                )
            })?;
            if now >= deadline_monotonic_ns {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_quiescence_deadline_reached",
                ));
            }
            let remaining_ns = deadline_monotonic_ns - now;
            let timeout_ms = remaining_ns
                .saturating_add(999_999)
                .checked_div(1_000_000)
                .unwrap_or(1)
                .clamp(1, libc::c_int::MAX as u64) as libc::c_int;
            let mut descriptor = libc::pollfd {
                fd,
                events: (libc::POLLPRI | libc::POLLERR) as libc::c_short,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
            if result > 0 {
                let invalid = (libc::POLLNVAL | libc::POLLHUP) as libc::c_short;
                if descriptor.revents & invalid != 0 {
                    return Err(CgroupProcessSetError::with_io(
                        "cgroup_process_set_events_poll_failed",
                        io::Error::from_raw_os_error(libc::EIO),
                    ));
                }
                let expected = (libc::POLLPRI | libc::POLLERR) as libc::c_short;
                if descriptor.revents & expected != 0 {
                    return Ok(());
                }
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_events_poll_unexpected",
                ));
            }
            if result == 0 {
                continue;
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(CgroupProcessSetError::with_io(
                "cgroup_process_set_events_poll_failed",
                error,
            ));
        }
    }

    fn parse_populated(bytes: &[u8]) -> Result<bool, CgroupProcessSetError> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| CgroupProcessSetError::new("cgroup_process_set_events_invalid"))?;
        let mut populated = None;
        for line in text.lines() {
            let mut fields = line.split_ascii_whitespace();
            let Some(name) = fields.next() else {
                continue;
            };
            let Some(value) = fields.next() else {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_events_invalid",
                ));
            };
            if fields.next().is_some() {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_events_invalid",
                ));
            }
            if name == "populated" {
                if populated.is_some() {
                    return Err(CgroupProcessSetError::new(
                        "cgroup_process_set_events_invalid",
                    ));
                }
                populated = match value {
                    "0" => Some(false),
                    "1" => Some(true),
                    _ => {
                        return Err(CgroupProcessSetError::new(
                            "cgroup_process_set_events_invalid",
                        ))
                    }
                };
            }
        }
        populated.ok_or_else(|| CgroupProcessSetError::new("cgroup_process_set_events_invalid"))
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct ParsedMembership {
        pids: Vec<u32>,
        duplicate_pid_observed: bool,
    }

    fn parse_member_pids(bytes: &[u8]) -> Result<ParsedMembership, CgroupProcessSetError> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| CgroupProcessSetError::new("cgroup_process_set_membership_invalid"))?;
        let mut pids = Vec::new();
        for line in text.lines() {
            if line.is_empty() {
                continue;
            }
            if line.bytes().any(|byte| !byte.is_ascii_digit()) {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_membership_invalid",
                ));
            }
            let pid = line
                .parse::<u32>()
                .map_err(|_| CgroupProcessSetError::new("cgroup_process_set_membership_invalid"))?;
            if pid == 0 {
                return Err(CgroupProcessSetError::new(
                    "cgroup_process_set_membership_invalid",
                ));
            }
            pids.push(pid);
        }
        pids.sort_unstable();
        let raw_count = pids.len();
        pids.dedup();
        Ok(ParsedMembership {
            duplicate_pid_observed: pids.len() != raw_count,
            pids,
        })
    }

    fn kernel_monotonic_now_ns() -> io::Result<u64> {
        let mut timestamp = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut timestamp) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let seconds = u64::try_from(timestamp.tv_sec)
            .map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
        let nanoseconds = u64::try_from(timestamp.tv_nsec)
            .map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
        seconds
            .checked_mul(1_000_000_000)
            .and_then(|value| value.checked_add(nanoseconds))
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))
    }

    fn remove_leaf(root: RawFd, leaf_name: &CStr) -> io::Result<()> {
        if unsafe { libc::unlinkat(root, leaf_name.as_ptr(), libc::AT_REMOVEDIR) } == 0 {
            return Ok(());
        }
        Err(io::Error::last_os_error())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;

        fn seed(value: u8) -> ProcessSetSeed {
            ProcessSetSeed::from_content_digest([value; IDENTITY_BYTES]).unwrap()
        }

        #[test]
        fn leaf_names_bind_root_seed_and_server_nonce() {
            let root = KernelCgroupIdentity([7; IDENTITY_BYTES]);
            let first = hash_identity(
                LEAF_NAME_DOMAIN,
                &[root.as_bytes(), seed(1).as_bytes(), &[2; IDENTITY_BYTES]],
            );
            let second = hash_identity(
                LEAF_NAME_DOMAIN,
                &[root.as_bytes(), seed(1).as_bytes(), &[3; IDENTITY_BYTES]],
            );
            assert_ne!(first, second);
            let name = format!("exec-{}", hex::encode(first.as_bytes()));
            assert_eq!(name.len(), "exec-".len() + 64);
            assert!(name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            assert!(!name.contains('/'));
            assert!(!name.contains(".."));
        }

        #[test]
        fn process_set_identity_changes_with_kernel_object_identity() {
            let root = KernelCgroupIdentity([9; IDENTITY_BYTES]);
            let fields = |inode: u64| {
                hash_identity(
                    PROCESS_SET_IDENTITY_DOMAIN,
                    &[
                        root.as_bytes(),
                        seed(1).as_bytes(),
                        &[2; IDENTITY_BYTES],
                        &5u64.to_be_bytes(),
                        &inode.to_be_bytes(),
                    ],
                )
            };
            assert_ne!(fields(10), fields(11));
        }

        #[test]
        fn event_parser_requires_one_binary_populated_field() {
            assert!(!parse_populated(b"populated 0\nfrozen 0\n").unwrap());
            assert!(parse_populated(b"populated 1\n").unwrap());
            for forged in [
                b"frozen 0\n".as_slice(),
                b"populated 2\n".as_slice(),
                b"populated 0\npopulated 1\n".as_slice(),
                b"populated\n".as_slice(),
                b"populated 0 extra\n".as_slice(),
            ] {
                assert_eq!(
                    parse_populated(forged).unwrap_err().code(),
                    "cgroup_process_set_events_invalid"
                );
            }
        }

        #[test]
        fn membership_parser_canonicalizes_and_marks_duplicate_pids() {
            let membership = parse_member_pids(b"42\n7\n").unwrap();
            assert_eq!(membership.pids, vec![7, 42]);
            assert!(!membership.duplicate_pid_observed);

            let duplicate = parse_member_pids(b"7\n7\n").unwrap();
            assert_eq!(duplicate.pids, vec![7]);
            assert!(duplicate.duplicate_pid_observed);

            for forged in [
                b"0\n".as_slice(),
                b"7 8\n".as_slice(),
                b"+7\n".as_slice(),
                b"4294967296\n".as_slice(),
            ] {
                assert_eq!(
                    parse_member_pids(forged).unwrap_err().code(),
                    "cgroup_process_set_membership_invalid"
                );
            }
        }

        #[test]
        fn ordinary_filesystem_cannot_impersonate_cgroup_v2() {
            let directory = tempfile::tempdir().unwrap();
            let error = match CgroupV2ProcessSetRoot::open_configured_root(directory.path()) {
                Ok(_) => panic!("ordinary filesystem accepted as cgroup v2"),
                Err(error) => error,
            };
            assert_eq!(error.code(), "cgroup_process_set_root_not_cgroup_v2");
        }

        #[test]
        fn domain_type_requires_an_exact_domain_value() {
            let directory = tempfile::tempdir().unwrap();
            let path = CString::new(directory.path().as_os_str().as_bytes()).unwrap();
            let directory_fd =
                open_path(&path, libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC).unwrap();

            for accepted in [b"domain".as_slice(), b"domain\n".as_slice()] {
                std::fs::write(directory.path().join("cgroup.type"), accepted).unwrap();
                require_domain_cgroup(directory_fd.as_raw_fd(), "cgroup_process_set_not_domain")
                    .unwrap();
            }

            for refused in [
                b"threaded\n".as_slice(),
                b"domain threaded\n".as_slice(),
                b"domain invalid\n".as_slice(),
                b" domain\n".as_slice(),
            ] {
                std::fs::write(directory.path().join("cgroup.type"), refused).unwrap();
                assert_eq!(
                    require_domain_cgroup(
                        directory_fd.as_raw_fd(),
                        "cgroup_process_set_not_domain",
                    )
                    .unwrap_err()
                    .code(),
                    "cgroup_process_set_not_domain"
                );
            }
        }

        #[test]
        fn configured_root_rejects_relative_and_parent_paths() {
            assert_eq!(
                normalized_absolute_relative(Path::new("relative/root"))
                    .unwrap_err()
                    .code(),
                "cgroup_process_set_root_path_not_absolute"
            );
            assert_eq!(
                normalized_absolute_relative(Path::new("/sys/fs/../cgroup"))
                    .unwrap_err()
                    .code(),
                "cgroup_process_set_root_path_invalid"
            );
        }

        #[test]
        fn configured_root_rejects_symlink_resolution() {
            let directory = tempfile::tempdir().unwrap();
            let target = directory.path().join("target");
            let link = directory.path().join("link");
            std::fs::create_dir(&target).unwrap();
            symlink(&target, &link).unwrap();
            let error = match CgroupV2ProcessSetRoot::open_configured_root(&link) {
                Ok(_) => panic!("symlinked cgroup root accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code(), "cgroup_process_set_root_open_failed");
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{
    CgroupMembershipSnapshot, CgroupProcessSet, CgroupProcessSetCleanup,
    CgroupProcessSetObservation, CgroupRootObservation, CgroupV2ProcessSetRoot,
};

#[cfg(not(target_os = "linux"))]
pub struct CgroupV2ProcessSetRoot;

#[cfg(not(target_os = "linux"))]
impl CgroupV2ProcessSetRoot {
    pub fn open_configured_root(_path: &Path) -> Result<Self, CgroupProcessSetError> {
        Err(CgroupProcessSetError::new(
            "cgroup_process_set_platform_unavailable",
        ))
    }
}

#[cfg(test)]
mod common_tests {
    use super::*;

    #[test]
    fn zero_seed_is_rejected() {
        assert_eq!(
            ProcessSetSeed::from_content_digest([0; IDENTITY_BYTES])
                .unwrap_err()
                .code(),
            "cgroup_process_set_seed_invalid"
        );
    }

    #[test]
    fn evidence_authority_cannot_claim_hmr_acceptance() {
        assert_eq!(
            CGROUP_PROCESS_SET_SCHEMA,
            "synthi.closed_execution.cgroup_process_set.v1"
        );
        assert!(CGROUP_PROCESS_SET_EVIDENCE_AUTHORITY.ends_with("not_gpu_hmr_acceptance"));
    }
}
