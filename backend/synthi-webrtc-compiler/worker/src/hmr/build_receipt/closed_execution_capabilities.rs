use super::{
    hash_field, prefixed_hash, BuildReceiptError, BuildReceiptVerifier, BuildTransactionChallenge,
};
use crate::runtime::closed_execution_provider::{
    ClosedExecutionRequirement, ClosedExecutionRequirementSet,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const RECEIPT_SCHEMA_VERSION: &str = "synthi.observed_closed_execution_capabilities.v2";
const RECEIPT_AUTHORITY: &str =
    "kernel_capability_observation_only_not_closed_execution_build_runtime_or_gpu_hmr_proof";
const RECEIPT_ID_PREFIX: &str = "closed-execution-capabilities:sha256:";
const POLICY_SCHEMA_VERSION: &str = "synthi.closed_build_execution_policy.v2";
const POLICY_ID_PREFIX: &str = "closed-execution-policy:sha256:";
const PROBE_TRANSPORT: &str = "disposable_syscall_only_child_fixed_record_v1";
#[cfg(not(target_os = "linux"))]
const LOCAL_ABSENCE_TRANSPORT: &str = "local_mechanic_absence_report_v1";
const PROBE_TIMEOUT_MILLISECONDS: i32 = 2_000;

const RESULT_OBSERVED: i32 = 0;
const RESULT_PREREQUISITE_MISSING: i32 = -1;
const RESULT_VERSION_INSUFFICIENT: i32 = -2;
const RESULT_NOT_OBSERVED: i32 = -3;
const RESULT_MECHANIC_UNAVAILABLE: i32 = -4;

const IMMUTABLE_SNAPSHOT: usize = 0;
const DESCRIPTOR_PROCESS_IDENTITY: usize = 1;
const CLOSE_ON_EXEC_RANGE: usize = 2;
const ROOT_SCOPED_PATH_RESOLUTION: usize = 3;
const NO_NEW_PRIVILEGES: usize = 4;
const ISOLATED_USER_NAMESPACE: usize = 5;
const ISOLATED_MOUNT_NAMESPACE: usize = 6;
const ISOLATED_NETWORK_NAMESPACE: usize = 7;
const PRIVATE_MOUNT_PROPAGATION: usize = 8;
const EPHEMERAL_ROOT_MOUNT: usize = 9;
const ROOT_SWITCH_AND_OLD_ROOT_DETACH: usize = 10;
const FILESYSTEM_RESTRICTION_V3: usize = 11;
const SYSCALL_FILTER_INSTALLATION: usize = 12;
const PROBE_WIRE_V1_CAPABILITY_COUNT: usize = 13;

#[derive(Debug, Clone, Copy)]
struct ProbeWireCapabilityDefinition {
    id: &'static str,
    wire_index: usize,
}

// This catalog describes one concrete probe wire format. It is not the closed
// execution policy: callers supply an open-vocabulary requirement set below.
const PROBE_WIRE_V1_CAPABILITIES: [ProbeWireCapabilityDefinition; PROBE_WIRE_V1_CAPABILITY_COUNT] = [
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.immutable_snapshot_sealing.v1",
        wire_index: IMMUTABLE_SNAPSHOT,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.descriptor_process_identity.v1",
        wire_index: DESCRIPTOR_PROCESS_IDENTITY,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.close_on_exec_range.v1",
        wire_index: CLOSE_ON_EXEC_RANGE,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.root_scoped_path_resolution.v1",
        wire_index: ROOT_SCOPED_PATH_RESOLUTION,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.no_new_privileges.v1",
        wire_index: NO_NEW_PRIVILEGES,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.isolated_user_namespace.v1",
        wire_index: ISOLATED_USER_NAMESPACE,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.isolated_mount_namespace.v1",
        wire_index: ISOLATED_MOUNT_NAMESPACE,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.isolated_network_namespace.v1",
        wire_index: ISOLATED_NETWORK_NAMESPACE,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.private_mount_propagation.v1",
        wire_index: PRIVATE_MOUNT_PROPAGATION,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.ephemeral_root_mount.v1",
        wire_index: EPHEMERAL_ROOT_MOUNT,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.root_switch_and_old_root_detach.v1",
        wire_index: ROOT_SWITCH_AND_OLD_ROOT_DETACH,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.filesystem_restriction_v3.v1",
        wire_index: FILESYSTEM_RESTRICTION_V3,
    },
    ProbeWireCapabilityDefinition {
        id: "synthi.closed_execution.capability.syscall_filter_installation.v1",
        wire_index: SYSCALL_FILTER_INSTALLATION,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CapabilityObservationOutcome {
    Observed,
    NotObserved,
    Unavailable,
    Blocked,
    PrerequisiteMissing,
    VersionInsufficient,
    ProbeFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedExecutionCapabilityObservation {
    capability_id: String,
    requirement_identity: String,
    outcome: CapabilityObservationOutcome,
    evidence_code: String,
    os_error_code: Option<i32>,
}

/// Verifier-minted evidence about mechanics required by the closed executor.
///
/// The receipt is deliberately support-only. Even a fully observed capability
/// set says nothing about which bytes a later process read or executed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObservedClosedExecutionCapabilitiesReceipt {
    schema_version: String,
    evidence_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_authorize_build: bool,
    can_satisfy_closed_execution: bool,
    can_satisfy_runtime_proof: bool,
    observer_id: String,
    clock_id: String,
    challenge_id: String,
    challenge_expires_monotonic_ns: u64,
    policy_schema_version: String,
    policy_id: String,
    requirement_set: ClosedExecutionRequirementSet,
    probe_transport: String,
    probe_process_id: Option<u32>,
    probe_started_monotonic_ns: u64,
    probe_completed_monotonic_ns: u64,
    probe_id: String,
    binding_id: String,
    observations: Vec<ClosedExecutionCapabilityObservation>,
    blocking_gaps: Vec<String>,
}

impl ObservedClosedExecutionCapabilitiesReceipt {
    pub(crate) fn policy_id(&self) -> &str {
        &self.policy_id
    }

    pub(crate) fn probe_id(&self) -> &str {
        &self.probe_id
    }

    pub(crate) fn blocking_gaps(&self) -> &[String] {
        &self.blocking_gaps
    }

    pub(crate) fn required_mechanics_observed(&self) -> bool {
        self.observations
            .iter()
            .all(|observation| observation.outcome == CapabilityObservationOutcome::Observed)
    }

    fn is_self_consistent(&self) -> bool {
        let canonical_requirements =
            ClosedExecutionRequirementSet::new(self.requirement_set.requirements().to_vec());
        if self.schema_version != RECEIPT_SCHEMA_VERSION
            || self.evidence_authority != RECEIPT_AUTHORITY
            || self.accepted_for_gpu_hmr
            || self.gpu_hmr_success
            || self.can_authorize_build
            || self.can_satisfy_closed_execution
            || self.can_satisfy_runtime_proof
            || self.policy_schema_version != POLICY_SCHEMA_VERSION
            || canonical_requirements.as_ref() != Ok(&self.requirement_set)
            || self.policy_id != derive_policy_id(&self.requirement_set)
            || self.probe_started_monotonic_ns > self.probe_completed_monotonic_ns
            || self.probe_completed_monotonic_ns >= self.challenge_expires_monotonic_ns
            || self.observations.len() != self.requirement_set.requirements().len()
        {
            return false;
        }
        for (requirement, observation) in self
            .requirement_set
            .requirements()
            .iter()
            .zip(&self.observations)
        {
            if observation.capability_id != requirement.obligation_id().as_str()
                || observation.requirement_identity != requirement.requirement_identity().as_str()
                || !valid_observation(observation)
            {
                return false;
            }
        }
        self.blocking_gaps == derive_blocking_gaps(&self.observations)
            && self.probe_id
                == derive_probe_id(
                    &self.policy_id,
                    &self.probe_transport,
                    self.probe_process_id,
                    &self.observations,
                )
            && self.binding_id
                == derive_binding_id(
                    &self.probe_id,
                    &self.observer_id,
                    &self.clock_id,
                    &self.challenge_id,
                    self.challenge_expires_monotonic_ns,
                    self.probe_started_monotonic_ns,
                    self.probe_completed_monotonic_ns,
                )
    }

    fn is_bound_to_challenge(&self, challenge: &BuildTransactionChallenge) -> bool {
        self.is_self_consistent()
            && self.observer_id == challenge.observer_id
            && self.clock_id == challenge.clock_id
            && self.challenge_id == challenge.challenge_id
            && self.challenge_expires_monotonic_ns == challenge.expires_monotonic_ns
    }
}

struct RawCapabilityProbe {
    transport: &'static str,
    process_id: Option<u32>,
    results: Vec<RawCapabilityResult>,
}

struct RawCapabilityResult {
    capability_id: &'static str,
    result: i32,
}

impl BuildReceiptVerifier {
    pub(crate) async fn observe_closed_execution_capabilities(
        &mut self,
        challenge: &BuildTransactionChallenge,
        requirements: &ClosedExecutionRequirementSet,
    ) -> Result<ObservedClosedExecutionCapabilitiesReceipt, BuildReceiptError> {
        let probe_started_monotonic_ns = self.validate_observation_challenge(challenge)?;
        let active = self
            .active_challenges
            .get(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        if active.registered_capability_probe_binding.is_some() {
            return Err(BuildReceiptError::new(
                "closed_execution_capability_probe_is_already_registered",
            ));
        }
        let raw = tokio::task::spawn_blocking(probe_kernel_capabilities_blocking)
            .await
            .map_err(|_| {
                BuildReceiptError::new("closed_execution_capability_probe_task_failed")
            })??;
        let probe_completed_monotonic_ns = self.validate_observation_challenge(challenge)?;
        let observations = observations_from_raw(&raw, requirements);
        let policy_id = derive_policy_id(requirements);
        let probe_id = derive_probe_id(&policy_id, raw.transport, raw.process_id, &observations);
        let binding_id = derive_binding_id(
            &probe_id,
            &challenge.observer_id,
            &challenge.clock_id,
            &challenge.challenge_id,
            challenge.expires_monotonic_ns,
            probe_started_monotonic_ns,
            probe_completed_monotonic_ns,
        );
        let receipt = ObservedClosedExecutionCapabilitiesReceipt {
            schema_version: RECEIPT_SCHEMA_VERSION.to_string(),
            evidence_authority: RECEIPT_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_authorize_build: false,
            can_satisfy_closed_execution: false,
            can_satisfy_runtime_proof: false,
            observer_id: challenge.observer_id.clone(),
            clock_id: challenge.clock_id.clone(),
            challenge_id: challenge.challenge_id.clone(),
            challenge_expires_monotonic_ns: challenge.expires_monotonic_ns,
            policy_schema_version: POLICY_SCHEMA_VERSION.to_string(),
            policy_id,
            requirement_set: requirements.clone(),
            probe_transport: raw.transport.to_string(),
            probe_process_id: raw.process_id,
            probe_started_monotonic_ns,
            probe_completed_monotonic_ns,
            probe_id,
            binding_id,
            blocking_gaps: derive_blocking_gaps(&observations),
            observations,
        };
        if !receipt.is_self_consistent() {
            return Err(BuildReceiptError::new(
                "closed_execution_capability_receipt_integrity_failed",
            ));
        }
        let active = self
            .active_challenges
            .get_mut(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        debug_assert!(active.registered_capability_probe_binding.is_none());
        active.registered_capability_probe_binding = Some(receipt.binding_id.clone());
        Ok(receipt)
    }

    pub(crate) fn closed_execution_capability_receipt<'a>(
        &mut self,
        challenge: &BuildTransactionChallenge,
        receipt: &'a ObservedClosedExecutionCapabilitiesReceipt,
    ) -> Result<&'a ObservedClosedExecutionCapabilitiesReceipt, BuildReceiptError> {
        // Registry membership proves that this verifier observed the probe. It
        // is intentionally reusable diagnostic provenance, not a consumable
        // authorization lease. The closed executor must mint a separate lease
        // bound to its exact child process and sealed artifact descriptors.
        self.validate_observation_challenge(challenge)?;
        if !receipt.is_bound_to_challenge(challenge) {
            return Err(BuildReceiptError::new(
                "closed_execution_capability_receipt_challenge_binding_mismatch",
            ));
        }
        let active = self
            .active_challenges
            .get(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        if active.registered_capability_probe_binding.as_deref()
            != Some(receipt.binding_id.as_str())
        {
            return Err(BuildReceiptError::new(
                "closed_execution_capability_receipt_registry_mismatch",
            ));
        }
        Ok(receipt)
    }
}

fn observations_from_raw(
    raw: &RawCapabilityProbe,
    requirements: &ClosedExecutionRequirementSet,
) -> Vec<ClosedExecutionCapabilityObservation> {
    requirements
        .requirements()
        .iter()
        .map(|requirement| {
            let result = if requirement.parameters().is_empty() {
                raw.results
                    .iter()
                    .find(|result| result.capability_id == requirement.obligation_id().as_str())
                    .map_or(RESULT_NOT_OBSERVED, |result| result.result)
            } else {
                RESULT_NOT_OBSERVED
            };
            observation_from_result(requirement, result)
        })
        .collect()
}

fn observation_from_result(
    requirement: &ClosedExecutionRequirement,
    result: i32,
) -> ClosedExecutionCapabilityObservation {
    let (outcome, evidence_code, os_error_code) = match result {
        RESULT_OBSERVED => (
            CapabilityObservationOutcome::Observed,
            "kernel_mechanic_observed",
            None,
        ),
        RESULT_PREREQUISITE_MISSING => (
            CapabilityObservationOutcome::PrerequisiteMissing,
            "required_mechanic_prerequisite_not_observed",
            None,
        ),
        RESULT_VERSION_INSUFFICIENT => (
            CapabilityObservationOutcome::VersionInsufficient,
            "required_mechanic_version_not_observed",
            None,
        ),
        RESULT_NOT_OBSERVED => (
            CapabilityObservationOutcome::NotObserved,
            "requested_mechanic_not_observed",
            None,
        ),
        RESULT_MECHANIC_UNAVAILABLE => (
            CapabilityObservationOutcome::Unavailable,
            "kernel_mechanic_unavailable",
            None,
        ),
        error if matches!(error, libc::ENOSYS | libc::EOPNOTSUPP | libc::EINVAL) => (
            CapabilityObservationOutcome::Unavailable,
            "kernel_mechanic_unavailable",
            Some(error),
        ),
        error if matches!(error, libc::EPERM | libc::EACCES) => (
            CapabilityObservationOutcome::Blocked,
            "runtime_policy_blocked_mechanic",
            Some(error),
        ),
        error if error > 0 => (
            CapabilityObservationOutcome::ProbeFailed,
            "kernel_mechanic_probe_failed",
            Some(error),
        ),
        _ => (
            CapabilityObservationOutcome::ProbeFailed,
            "kernel_mechanic_probe_incomplete",
            None,
        ),
    };
    ClosedExecutionCapabilityObservation {
        capability_id: requirement.obligation_id().as_str().to_string(),
        requirement_identity: requirement.requirement_identity().as_str().to_string(),
        outcome,
        evidence_code: evidence_code.to_string(),
        os_error_code,
    }
}

fn valid_observation(observation: &ClosedExecutionCapabilityObservation) -> bool {
    let expected = match observation.outcome {
        CapabilityObservationOutcome::Observed => ("kernel_mechanic_observed", false),
        CapabilityObservationOutcome::NotObserved => ("requested_mechanic_not_observed", false),
        CapabilityObservationOutcome::Unavailable => {
            return observation.evidence_code == "kernel_mechanic_unavailable"
                && observation.os_error_code.is_none_or(|error| error > 0);
        }
        CapabilityObservationOutcome::Blocked => ("runtime_policy_blocked_mechanic", true),
        CapabilityObservationOutcome::PrerequisiteMissing => {
            ("required_mechanic_prerequisite_not_observed", false)
        }
        CapabilityObservationOutcome::VersionInsufficient => {
            ("required_mechanic_version_not_observed", false)
        }
        CapabilityObservationOutcome::ProbeFailed => {
            let code_matches = matches!(
                observation.evidence_code.as_str(),
                "kernel_mechanic_probe_failed" | "kernel_mechanic_probe_incomplete"
            );
            return code_matches
                && (observation.evidence_code == "kernel_mechanic_probe_failed")
                    == observation.os_error_code.is_some();
        }
    };
    observation.evidence_code == expected.0
        && observation.os_error_code.is_some() == expected.1
        && observation.os_error_code.is_none_or(|error| error > 0)
}

fn derive_blocking_gaps(observations: &[ClosedExecutionCapabilityObservation]) -> Vec<String> {
    observations
        .iter()
        .filter(|observation| observation.outcome != CapabilityObservationOutcome::Observed)
        .map(|observation| {
            format!(
                "closed_execution_required_mechanic_not_observed:{}:{}:{}",
                observation.capability_id,
                observation.requirement_identity,
                observation.evidence_code
            )
        })
        .collect()
}

fn derive_policy_id(requirements: &ClosedExecutionRequirementSet) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, POLICY_SCHEMA_VERSION.as_bytes());
    hash_field(&mut hasher, requirements.identity().as_str().as_bytes());
    format!("{POLICY_ID_PREFIX}{:x}", hasher.finalize())
}

fn derive_probe_id(
    policy_id: &str,
    transport: &str,
    process_id: Option<u32>,
    observations: &[ClosedExecutionCapabilityObservation],
) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, RECEIPT_SCHEMA_VERSION.as_bytes());
    hash_field(&mut hasher, RECEIPT_AUTHORITY.as_bytes());
    hasher.update([0; 5]);
    hash_field(&mut hasher, policy_id.as_bytes());
    hash_field(&mut hasher, transport.as_bytes());
    hasher.update([u8::from(process_id.is_some())]);
    hasher.update(process_id.unwrap_or_default().to_be_bytes());
    hasher.update((observations.len() as u64).to_be_bytes());
    for observation in observations {
        hash_field(&mut hasher, observation.capability_id.as_bytes());
        hash_field(&mut hasher, observation.requirement_identity.as_bytes());
        hash_field(
            &mut hasher,
            match observation.outcome {
                CapabilityObservationOutcome::Observed => b"observed",
                CapabilityObservationOutcome::NotObserved => b"not_observed",
                CapabilityObservationOutcome::Unavailable => b"unavailable",
                CapabilityObservationOutcome::Blocked => b"blocked",
                CapabilityObservationOutcome::PrerequisiteMissing => b"prerequisite_missing",
                CapabilityObservationOutcome::VersionInsufficient => b"version_insufficient",
                CapabilityObservationOutcome::ProbeFailed => b"probe_failed",
            },
        );
        hash_field(&mut hasher, observation.evidence_code.as_bytes());
        hasher.update(observation.os_error_code.unwrap_or_default().to_be_bytes());
    }
    format!("{RECEIPT_ID_PREFIX}{:x}", hasher.finalize())
}

#[allow(clippy::too_many_arguments)]
fn derive_binding_id(
    probe_id: &str,
    observer_id: &str,
    clock_id: &str,
    challenge_id: &str,
    challenge_expires_monotonic_ns: u64,
    probe_started_monotonic_ns: u64,
    probe_completed_monotonic_ns: u64,
) -> String {
    prefixed_hash(
        "closed-execution-capability-binding:sha256:",
        b"synthi.closed_execution_capability_binding.v1",
        &[
            probe_id.as_bytes(),
            observer_id.as_bytes(),
            clock_id.as_bytes(),
            challenge_id.as_bytes(),
            &challenge_expires_monotonic_ns.to_be_bytes(),
            &probe_started_monotonic_ns.to_be_bytes(),
            &probe_completed_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LinuxCapabilityProbeWire {
    magic: u64,
    version: u32,
    process_id: u32,
    reserved: u32,
    results: [i32; PROBE_WIRE_V1_CAPABILITY_COUNT],
}

#[cfg(target_os = "linux")]
const PROBE_WIRE_RESULTS_OFFSET: usize = 20;
#[cfg(target_os = "linux")]
const PROBE_WIRE_SIZE: usize = PROBE_WIRE_RESULTS_OFFSET + PROBE_WIRE_V1_CAPABILITY_COUNT * 4;

#[cfg(target_os = "linux")]
const PROBE_WIRE_MAGIC: u64 = 0x53594e544849434c;

#[cfg(target_os = "linux")]
struct LinuxProbeInputs {
    root_path: std::ffi::CString,
    old_root_path: std::ffi::CString,
    resolution_root_path: std::ffi::CString,
    resolution_outside_path: std::ffi::CString,
    landlock_root_path: std::ffi::CString,
    uid_map: Vec<u8>,
    gid_map: Vec<u8>,
    parent_process_id: libc::pid_t,
}

#[cfg(target_os = "linux")]
fn probe_kernel_capabilities_blocking() -> Result<RawCapabilityProbe, BuildReceiptError> {
    use std::os::unix::ffi::OsStrExt;

    let root = tempfile::tempdir().map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_root_unavailable")
    })?;
    let root_path = std::fs::canonicalize(root.path()).map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_root_resolution_failed")
    })?;
    let old_root_path = root_path.join(".old-root");
    let resolution_root_path = root_path.join("resolution-root");
    let resolution_inside_path = resolution_root_path.join("inside");
    let resolution_escape_path = resolution_root_path.join("escape");
    let resolution_outside_path = root_path.join("outside");
    let landlock_root = tempfile::tempdir().map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_landlock_root_unavailable")
    })?;
    let landlock_root_path = std::fs::canonicalize(landlock_root.path()).map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_landlock_root_resolution_failed")
    })?;
    std::fs::create_dir(&resolution_root_path).map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_resolution_root_unavailable")
    })?;
    std::fs::write(&resolution_inside_path, b"inside").map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_resolution_file_unavailable")
    })?;
    std::fs::write(&resolution_outside_path, b"outside").map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_resolution_file_unavailable")
    })?;
    std::os::unix::fs::symlink("../outside", &resolution_escape_path).map_err(|_| {
        BuildReceiptError::new("closed_execution_capability_probe_resolution_link_unavailable")
    })?;
    let inputs = LinuxProbeInputs {
        root_path: std::ffi::CString::new(root_path.as_os_str().as_bytes()).map_err(|_| {
            BuildReceiptError::new("closed_execution_capability_probe_root_is_invalid")
        })?,
        old_root_path: std::ffi::CString::new(old_root_path.as_os_str().as_bytes()).map_err(
            |_| BuildReceiptError::new("closed_execution_capability_probe_root_is_invalid"),
        )?,
        resolution_root_path: std::ffi::CString::new(resolution_root_path.as_os_str().as_bytes())
            .map_err(|_| {
            BuildReceiptError::new("closed_execution_capability_probe_root_is_invalid")
        })?,
        resolution_outside_path: std::ffi::CString::new(
            resolution_outside_path.as_os_str().as_bytes(),
        )
        .map_err(|_| BuildReceiptError::new("closed_execution_capability_probe_root_is_invalid"))?,
        landlock_root_path: std::ffi::CString::new(landlock_root_path.as_os_str().as_bytes())
            .map_err(|_| {
                BuildReceiptError::new("closed_execution_capability_probe_root_is_invalid")
            })?,
        uid_map: format!("0 {} 1\n", unsafe { libc::geteuid() }).into_bytes(),
        gid_map: format!("0 {} 1\n", unsafe { libc::getegid() }).into_bytes(),
        parent_process_id: unsafe { libc::getpid() },
    };

    let mut pipe_fds = [-1; 2];
    if unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(BuildReceiptError::new(
            "closed_execution_capability_probe_pipe_unavailable",
        ));
    }
    // SAFETY: every input needed by the child is materialized before fork.
    // The child path performs stack-only control flow and raw kernel/libc calls,
    // never allocates, locks, unwinds, logs, or enters the async runtime. This
    // receipt remains support-only; an authorizing executor needs a dedicated
    // child-bound launcher and cannot consume this probe as execution proof.
    let child = unsafe { libc::fork() };
    if child < 0 {
        close_raw_fd(pipe_fds[0]);
        close_raw_fd(pipe_fds[1]);
        return Err(BuildReceiptError::new(
            "closed_execution_capability_probe_child_unavailable",
        ));
    }
    if child == 0 {
        close_raw_fd(pipe_fds[0]);
        run_linux_probe_child(pipe_fds[1], &inputs);
    }

    close_raw_fd(pipe_fds[1]);
    let read_fd = pipe_fds[0];
    let mut poll_fd = libc::pollfd {
        fd: read_fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let poll_result = loop {
        let result = unsafe { libc::poll(&mut poll_fd, 1, PROBE_TIMEOUT_MILLISECONDS) };
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        break result;
    };
    if poll_result <= 0 || poll_fd.revents & (libc::POLLIN | libc::POLLHUP) == 0 {
        terminate_probe_child(child);
        close_raw_fd(read_fd);
        return Err(BuildReceiptError::new(if poll_result == 0 {
            "closed_execution_capability_probe_timed_out"
        } else {
            "closed_execution_capability_probe_transport_failed"
        }));
    }

    let mut wire_bytes = [0u8; PROBE_WIRE_SIZE];
    let read_ok = read_exact_raw(read_fd, &mut wire_bytes);
    close_raw_fd(read_fd);
    let wire = decode_linux_probe_wire(&wire_bytes);
    let mut status = 0;
    let waited = loop {
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        break result;
    };
    if !read_ok
        || waited != child
        || !libc::WIFEXITED(status)
        || libc::WEXITSTATUS(status) != 0
        || wire.magic != PROBE_WIRE_MAGIC
        || wire.version != 1
        || wire.process_id != child as u32
        || wire.reserved != 0
    {
        if waited != child {
            terminate_probe_child(child);
        }
        return Err(BuildReceiptError::new(
            "closed_execution_capability_probe_result_invalid",
        ));
    }
    Ok(RawCapabilityProbe {
        transport: PROBE_TRANSPORT,
        process_id: Some(wire.process_id),
        results: PROBE_WIRE_V1_CAPABILITIES
            .iter()
            .map(|definition| RawCapabilityResult {
                capability_id: definition.id,
                result: wire.results[definition.wire_index],
            })
            .collect(),
    })
}

#[cfg(not(target_os = "linux"))]
fn probe_kernel_capabilities_blocking() -> Result<RawCapabilityProbe, BuildReceiptError> {
    Ok(RawCapabilityProbe {
        transport: LOCAL_ABSENCE_TRANSPORT,
        process_id: None,
        results: Vec::new(),
    })
}

#[cfg(target_os = "linux")]
fn run_linux_probe_child(write_fd: libc::c_int, inputs: &LinuxProbeInputs) -> ! {
    let mut wire = LinuxCapabilityProbeWire {
        magic: PROBE_WIRE_MAGIC,
        version: 1,
        process_id: unsafe { libc::getpid() } as u32,
        reserved: 0,
        results: [RESULT_NOT_OBSERVED; PROBE_WIRE_V1_CAPABILITY_COUNT],
    };
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
        unsafe { libc::_exit(127) }
    }
    if unsafe { libc::getppid() } != inputs.parent_process_id {
        unsafe { libc::_exit(127) }
    }

    let snapshot_fd = probe_immutable_snapshot(&mut wire.results[IMMUTABLE_SNAPSHOT]);
    wire.results[DESCRIPTOR_PROCESS_IDENTITY] = probe_pidfd_identity();
    wire.results[CLOSE_ON_EXEC_RANGE] = snapshot_fd.map_or(RESULT_PREREQUISITE_MISSING, |fd| {
        probe_close_on_exec_range(fd)
    });
    wire.results[ROOT_SCOPED_PATH_RESOLUTION] = probe_root_scoped_path_resolution(inputs);
    wire.results[NO_NEW_PRIVILEGES] =
        syscall_status(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) });

    wire.results[ISOLATED_USER_NAMESPACE] = probe_user_namespace_in_descendant(inputs);
    // A user namespace is one possible source of namespace authority, not an
    // isolation requirement. Try directly delegated authority first without
    // mutating the probe that established the optional user-namespace result.
    wire.results[ISOLATED_MOUNT_NAMESPACE] =
        syscall_status(unsafe { libc::unshare(libc::CLONE_NEWNS) });
    wire.results[ISOLATED_NETWORK_NAMESPACE] =
        syscall_status(unsafe { libc::unshare(libc::CLONE_NEWNET) });
    if (wire.results[ISOLATED_MOUNT_NAMESPACE] != RESULT_OBSERVED
        || wire.results[ISOLATED_NETWORK_NAMESPACE] != RESULT_OBSERVED)
        && wire.results[ISOLATED_USER_NAMESPACE] == RESULT_OBSERVED
    {
        let entered_user_namespace = probe_user_namespace(inputs);
        wire.results[ISOLATED_USER_NAMESPACE] = entered_user_namespace;
        if entered_user_namespace == RESULT_OBSERVED {
            wire.results[ISOLATED_MOUNT_NAMESPACE] =
                syscall_status(unsafe { libc::unshare(libc::CLONE_NEWNS) });
            wire.results[ISOLATED_NETWORK_NAMESPACE] =
                syscall_status(unsafe { libc::unshare(libc::CLONE_NEWNET) });
        }
    }
    if wire.results[ISOLATED_MOUNT_NAMESPACE] == RESULT_OBSERVED {
        wire.results[PRIVATE_MOUNT_PROPAGATION] = syscall_status(unsafe {
            libc::mount(
                std::ptr::null(),
                b"/\0".as_ptr().cast(),
                std::ptr::null(),
                (libc::MS_REC | libc::MS_PRIVATE) as libc::c_ulong,
                std::ptr::null(),
            )
        });
        wire.results[EPHEMERAL_ROOT_MOUNT] = syscall_status(unsafe {
            libc::mount(
                b"tmpfs\0".as_ptr().cast(),
                inputs.root_path.as_ptr(),
                b"tmpfs\0".as_ptr().cast(),
                (libc::MS_NODEV | libc::MS_NOSUID) as libc::c_ulong,
                b"size=1048576,mode=0700\0".as_ptr().cast(),
            )
        });
    } else {
        wire.results[PRIVATE_MOUNT_PROPAGATION] = RESULT_PREREQUISITE_MISSING;
        wire.results[EPHEMERAL_ROOT_MOUNT] = RESULT_PREREQUISITE_MISSING;
    }
    wire.results[ROOT_SWITCH_AND_OLD_ROOT_DETACH] =
        if wire.results[EPHEMERAL_ROOT_MOUNT] == RESULT_OBSERVED {
            probe_root_switch(inputs)
        } else {
            RESULT_PREREQUISITE_MISSING
        };
    wire.results[FILESYSTEM_RESTRICTION_V3] = probe_landlock_v3(
        inputs,
        wire.results[ROOT_SWITCH_AND_OLD_ROOT_DETACH] == RESULT_OBSERVED,
    );
    wire.results[SYSCALL_FILTER_INSTALLATION] = probe_allow_only_seccomp_filter();

    if let Some(fd) = snapshot_fd {
        close_raw_fd(fd);
    }
    let bytes = encode_linux_probe_wire(&wire);
    let wrote = write_all_raw(write_fd, &bytes);
    close_raw_fd(write_fd);
    unsafe { libc::_exit(if wrote { 0 } else { 126 }) }
}

#[cfg(target_os = "linux")]
fn encode_linux_probe_wire(wire: &LinuxCapabilityProbeWire) -> [u8; PROBE_WIRE_SIZE] {
    let mut bytes = [0u8; PROBE_WIRE_SIZE];
    bytes[0..8].copy_from_slice(&wire.magic.to_le_bytes());
    bytes[8..12].copy_from_slice(&wire.version.to_le_bytes());
    bytes[12..16].copy_from_slice(&wire.process_id.to_le_bytes());
    bytes[16..20].copy_from_slice(&wire.reserved.to_le_bytes());
    for (index, result) in wire.results.iter().enumerate() {
        let offset = PROBE_WIRE_RESULTS_OFFSET + index * 4;
        bytes[offset..offset + 4].copy_from_slice(&result.to_le_bytes());
    }
    bytes
}

#[cfg(target_os = "linux")]
fn decode_linux_probe_wire(bytes: &[u8; PROBE_WIRE_SIZE]) -> LinuxCapabilityProbeWire {
    let read_u32 = |offset: usize| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    let mut results = [RESULT_NOT_OBSERVED; PROBE_WIRE_V1_CAPABILITY_COUNT];
    for (index, result) in results.iter_mut().enumerate() {
        let offset = PROBE_WIRE_RESULTS_OFFSET + index * 4;
        *result = i32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
    }
    LinuxCapabilityProbeWire {
        magic: u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]),
        version: read_u32(8),
        process_id: read_u32(12),
        reserved: read_u32(16),
        results,
    }
}

#[cfg(target_os = "linux")]
fn probe_immutable_snapshot(result: &mut i32) -> Option<libc::c_int> {
    let fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            b"synthi-closed-execution-probe\0"
                .as_ptr()
                .cast::<libc::c_char>(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    if fd < 0 || fd > libc::c_int::MAX as libc::c_long {
        *result = last_errno();
        return None;
    }
    let fd = fd as libc::c_int;
    if unsafe { libc::ftruncate(fd, 1) } != 0 {
        *result = last_errno();
        close_raw_fd(fd);
        return None;
    }
    let required = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, required) } != 0 {
        *result = last_errno();
        close_raw_fd(fd);
        return None;
    }
    let observed = unsafe { libc::fcntl(fd, libc::F_GET_SEALS) };
    if observed < 0 || observed & required != required {
        *result = if observed < 0 {
            last_errno()
        } else {
            libc::EIO
        };
        close_raw_fd(fd);
        return None;
    }
    *result = RESULT_OBSERVED;
    Some(fd)
}

#[cfg(target_os = "linux")]
fn probe_pidfd_identity() -> i32 {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
    if fd < 0 || fd > libc::c_int::MAX as libc::c_long {
        return last_errno();
    }
    close_raw_fd(fd as libc::c_int);
    RESULT_OBSERVED
}

#[cfg(target_os = "linux")]
fn probe_close_on_exec_range(fd: libc::c_int) -> i32 {
    const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
    let existing_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if existing_flags < 0 {
        return last_errno();
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, existing_flags & !libc::FD_CLOEXEC) } != 0 {
        return last_errno();
    }
    let result = unsafe {
        libc::syscall(
            libc::SYS_close_range,
            fd as libc::c_uint,
            fd as libc::c_uint,
            CLOSE_RANGE_CLOEXEC,
        )
    };
    if result != 0 {
        return last_errno();
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        last_errno()
    } else if flags & libc::FD_CLOEXEC == 0 {
        libc::EIO
    } else {
        RESULT_OBSERVED
    }
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[cfg(target_os = "linux")]
fn probe_root_scoped_path_resolution(inputs: &LinuxProbeInputs) -> i32 {
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_IN_ROOT: u64 = 0x10;
    let root_fd = unsafe {
        libc::open(
            inputs.resolution_root_path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return last_errno();
    }

    // Positive controls prove both paths would leave the disposable root if
    // ordinary path traversal or symlink following were allowed.
    for escape in [b"../outside\0".as_slice(), b"escape\0".as_slice()] {
        let escaped = unsafe {
            libc::openat(
                root_fd,
                escape.as_ptr().cast::<libc::c_char>(),
                libc::O_RDONLY | libc::O_CLOEXEC,
            )
        };
        if escaped < 0 {
            let error = last_errno();
            close_raw_fd(root_fd);
            return error;
        }
        close_raw_fd(escaped);
    }

    let how = OpenHow {
        flags: (libc::O_PATH | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    let opened = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root_fd,
            b"inside\0".as_ptr().cast::<libc::c_char>(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if opened < 0 {
        let error = last_errno();
        close_raw_fd(root_fd);
        return error;
    }
    close_raw_fd(opened as libc::c_int);

    for (escape, expected_error) in [
        (b"../outside\0".as_slice(), libc::ENOENT),
        (b"escape\0".as_slice(), libc::ELOOP),
    ] {
        let escaped = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root_fd,
                escape.as_ptr().cast::<libc::c_char>(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if escaped >= 0 {
            close_raw_fd(escaped as libc::c_int);
            close_raw_fd(root_fd);
            return libc::EIO;
        }
        if last_errno() != expected_error {
            close_raw_fd(root_fd);
            return libc::EIO;
        }
    }

    let outside_fd = unsafe {
        libc::open(
            inputs.resolution_outside_path.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if outside_fd < 0 {
        let error = last_errno();
        close_raw_fd(root_fd);
        return error;
    }
    let host_root_fd = unsafe {
        libc::open(
            b"/\0".as_ptr().cast(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if host_root_fd < 0 {
        let error = last_errno();
        close_raw_fd(outside_fd);
        close_raw_fd(root_fd);
        return error;
    }
    let mut magic_path = [0u8; 64];
    let Some(magic_path) = proc_self_fd_path(outside_fd, &mut magic_path) else {
        close_raw_fd(host_root_fd);
        close_raw_fd(outside_fd);
        close_raw_fd(root_fd);
        return libc::EIO;
    };
    let magic_how = OpenHow {
        flags: libc::O_RDONLY as u64,
        mode: 0,
        resolve: RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS,
    };
    let magic_open = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            host_root_fd,
            magic_path.as_ptr().cast::<libc::c_char>(),
            &magic_how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    let magic_error = if magic_open < 0 {
        last_errno()
    } else {
        close_raw_fd(magic_open as libc::c_int);
        0
    };
    close_raw_fd(host_root_fd);
    close_raw_fd(outside_fd);
    close_raw_fd(root_fd);
    if magic_error == libc::ELOOP {
        RESULT_OBSERVED
    } else {
        libc::EIO
    }
}

#[cfg(target_os = "linux")]
fn proc_self_fd_path(fd: libc::c_int, output: &mut [u8; 64]) -> Option<&[u8]> {
    if fd < 0 {
        return None;
    }
    const PREFIX: &[u8] = b"proc/self/fd/";
    output[..PREFIX.len()].copy_from_slice(PREFIX);
    let mut reversed = [0u8; 10];
    let mut value = fd as u32;
    let mut digit_count = 0;
    loop {
        reversed[digit_count] = b'0' + (value % 10) as u8;
        digit_count += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    let end = PREFIX.len() + digit_count;
    for index in 0..digit_count {
        output[PREFIX.len() + index] = reversed[digit_count - index - 1];
    }
    output[end] = 0;
    Some(&output[..=end])
}

#[cfg(target_os = "linux")]
fn probe_user_namespace(inputs: &LinuxProbeInputs) -> i32 {
    let status = syscall_status(unsafe { libc::unshare(libc::CLONE_NEWUSER) });
    if status != RESULT_OBSERVED {
        return status;
    }
    let setgroups = write_proc_file(b"/proc/self/setgroups\0", b"deny\n");
    if setgroups != RESULT_OBSERVED && setgroups != libc::ENOENT {
        return setgroups;
    }
    let uid_map = write_proc_file(b"/proc/self/uid_map\0", &inputs.uid_map);
    if uid_map != RESULT_OBSERVED {
        return uid_map;
    }
    write_proc_file(b"/proc/self/gid_map\0", &inputs.gid_map)
}

#[cfg(target_os = "linux")]
fn probe_user_namespace_in_descendant(inputs: &LinuxProbeInputs) -> i32 {
    let mut pipe_fds = [-1; 2];
    if unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return last_errno();
    }
    let parent_process_id = unsafe { libc::getpid() };
    let child = unsafe { libc::fork() };
    if child < 0 {
        let error = last_errno();
        close_raw_fd(pipe_fds[0]);
        close_raw_fd(pipe_fds[1]);
        return error;
    }
    if child == 0 {
        close_raw_fd(pipe_fds[0]);
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
            unsafe { libc::_exit(127) }
        }
        if unsafe { libc::getppid() } != parent_process_id {
            unsafe { libc::_exit(127) }
        }
        let result = probe_user_namespace(inputs);
        let bytes = result.to_ne_bytes();
        let wrote = write_all_raw(pipe_fds[1], &bytes);
        close_raw_fd(pipe_fds[1]);
        unsafe { libc::_exit(if wrote { 0 } else { 126 }) }
    }

    close_raw_fd(pipe_fds[1]);
    let mut poll_fd = libc::pollfd {
        fd: pipe_fds[0],
        events: libc::POLLIN,
        revents: 0,
    };
    let polled = loop {
        let result = unsafe { libc::poll(&mut poll_fd, 1, PROBE_TIMEOUT_MILLISECONDS / 2) };
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        break result;
    };
    let mut result_bytes = [0u8; std::mem::size_of::<i32>()];
    let read_ok = polled > 0
        && poll_fd.revents & (libc::POLLIN | libc::POLLHUP) != 0
        && read_exact_raw(pipe_fds[0], &mut result_bytes);
    close_raw_fd(pipe_fds[0]);
    let mut status = 0;
    let waited = if read_ok {
        loop {
            let result = unsafe { libc::waitpid(child, &mut status, 0) };
            if result < 0 && last_errno() == libc::EINTR {
                continue;
            }
            break result;
        }
    } else {
        terminate_probe_child(child);
        child
    };
    if !read_ok || waited != child || !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
        RESULT_NOT_OBSERVED
    } else {
        i32::from_ne_bytes(result_bytes)
    }
}

#[cfg(target_os = "linux")]
fn probe_root_switch(inputs: &LinuxProbeInputs) -> i32 {
    if unsafe { libc::mkdir(inputs.old_root_path.as_ptr(), 0o700) } != 0 {
        return last_errno();
    }
    if unsafe { libc::chdir(inputs.root_path.as_ptr()) } != 0 {
        return last_errno();
    }
    let pivoted = unsafe {
        libc::syscall(
            libc::SYS_pivot_root,
            b".\0".as_ptr().cast::<libc::c_char>(),
            b".old-root\0".as_ptr().cast::<libc::c_char>(),
        )
    };
    if pivoted != 0 {
        return last_errno();
    }
    if unsafe { libc::chdir(b"/\0".as_ptr().cast()) } != 0 {
        return last_errno();
    }
    if unsafe { libc::umount2(b"/.old-root\0".as_ptr().cast(), libc::MNT_DETACH) } != 0 {
        return last_errno();
    }
    if unsafe { libc::rmdir(b"/.old-root\0".as_ptr().cast()) } != 0 {
        return last_errno();
    }
    RESULT_OBSERVED
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
}

#[cfg(target_os = "linux")]
#[repr(C, packed)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[cfg(target_os = "linux")]
fn probe_landlock_v3(inputs: &LinuxProbeInputs, root_switched: bool) -> i32 {
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;
    const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
    const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
    const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
    const LANDLOCK_ACCESS_FS_ALL_V3: u64 = (1 << 15) - 1;
    const WRITE_PROBE_NAME: &[u8] = b".synthi-landlock-write-probe\0";
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<LandlockRulesetAttr>(),
            0,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if abi < 0 {
        return last_errno();
    }
    if abi < 3 {
        return RESULT_VERSION_INSUFFICIENT;
    }
    let attr = LandlockRulesetAttr {
        handled_access_fs: LANDLOCK_ACCESS_FS_ALL_V3,
    };
    let ruleset = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr,
            std::mem::size_of::<LandlockRulesetAttr>(),
            0,
        )
    };
    if ruleset < 0 || ruleset > libc::c_int::MAX as libc::c_long {
        return last_errno();
    }
    let root_path = if root_switched {
        b"/\0".as_ptr().cast()
    } else {
        inputs.landlock_root_path.as_ptr()
    };
    let root_fd = unsafe {
        libc::open(
            root_path,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        let error = last_errno();
        close_raw_fd(ruleset as libc::c_int);
        return error;
    }
    let control_fd = unsafe {
        libc::openat(
            root_fd,
            WRITE_PROBE_NAME.as_ptr().cast(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
            0o600,
        )
    };
    if control_fd < 0 {
        let error = last_errno();
        close_raw_fd(root_fd);
        close_raw_fd(ruleset as libc::c_int);
        return error;
    }
    close_raw_fd(control_fd);
    if unsafe { libc::unlinkat(root_fd, WRITE_PROBE_NAME.as_ptr().cast(), 0) } != 0 {
        let error = last_errno();
        close_raw_fd(root_fd);
        close_raw_fd(ruleset as libc::c_int);
        return error;
    }
    let path_rule = LandlockPathBeneathAttr {
        allowed_access: LANDLOCK_ACCESS_FS_EXECUTE
            | LANDLOCK_ACCESS_FS_READ_FILE
            | LANDLOCK_ACCESS_FS_READ_DIR,
        parent_fd: root_fd,
    };
    let rule_added = unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset,
            LANDLOCK_RULE_PATH_BENEATH,
            &path_rule,
            0,
        )
    };
    let rule_error = if rule_added != 0 { last_errno() } else { 0 };
    close_raw_fd(root_fd);
    if rule_added != 0 {
        close_raw_fd(ruleset as libc::c_int);
        return rule_error;
    }
    let restricted = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0) };
    let restrict_error = if restricted != 0 { last_errno() } else { 0 };
    close_raw_fd(ruleset as libc::c_int);
    if restricted != 0 {
        return restrict_error;
    }

    let restricted_root_fd = unsafe {
        libc::open(
            root_path,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if restricted_root_fd < 0 {
        return last_errno();
    }
    let denied_fd = unsafe {
        libc::openat(
            restricted_root_fd,
            WRITE_PROBE_NAME.as_ptr().cast(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
            0o600,
        )
    };
    let denied_error = if denied_fd < 0 { last_errno() } else { 0 };
    if denied_fd >= 0 {
        close_raw_fd(denied_fd);
        unsafe {
            libc::unlinkat(restricted_root_fd, WRITE_PROBE_NAME.as_ptr().cast(), 0);
        }
    }
    close_raw_fd(restricted_root_fd);
    if denied_error == libc::EACCES {
        RESULT_OBSERVED
    } else {
        libc::EIO
    }
}

#[cfg(target_os = "linux")]
fn probe_allow_only_seccomp_filter() -> i32 {
    const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    let mut filter = [
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
            jt: 0,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            jt: 0,
            jf: 1,
            k: libc::SYS_getppid as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ERRNO | libc::EPERM as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as u16,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ALLOW,
        },
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    let installed = syscall_status(unsafe {
        libc::syscall(libc::SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) as libc::c_int
    });
    if installed != RESULT_OBSERVED {
        return installed;
    }
    let denied = unsafe { libc::syscall(libc::SYS_getppid) };
    if denied == -1 && last_errno() == libc::EPERM {
        RESULT_OBSERVED
    } else {
        libc::EIO
    }
}

#[cfg(target_os = "linux")]
fn write_proc_file(path: &'static [u8], bytes: &[u8]) -> i32 {
    let fd = unsafe {
        libc::open(
            path.as_ptr().cast::<libc::c_char>(),
            libc::O_WRONLY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return last_errno();
    }
    let status = if write_all_raw(fd, bytes) {
        RESULT_OBSERVED
    } else {
        last_errno()
    };
    close_raw_fd(fd);
    status
}

#[cfg(target_os = "linux")]
fn syscall_status(result: libc::c_int) -> i32 {
    if result == 0 {
        RESULT_OBSERVED
    } else {
        last_errno()
    }
}

#[cfg(target_os = "linux")]
fn write_all_raw(fd: libc::c_int, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            if last_errno() == libc::EINTR {
                continue;
            }
            return false;
        }
        if written == 0 {
            return false;
        }
        bytes = &bytes[written as usize..];
    }
    true
}

#[cfg(target_os = "linux")]
fn read_exact_raw(fd: libc::c_int, mut bytes: &mut [u8]) -> bool {
    while !bytes.is_empty() {
        let read = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if read < 0 {
            if last_errno() == libc::EINTR {
                continue;
            }
            return false;
        }
        if read == 0 {
            return false;
        }
        let (_, remaining) = std::mem::take(&mut bytes).split_at_mut(read as usize);
        bytes = remaining;
    }
    true
}

#[cfg(target_os = "linux")]
fn terminate_probe_child(child: libc::pid_t) {
    unsafe {
        libc::kill(child, libc::SIGKILL);
    }
    let mut status = 0;
    loop {
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        if result < 0 && last_errno() == libc::EINTR {
            continue;
        }
        break;
    }
}

#[cfg(target_os = "linux")]
fn close_raw_fd(fd: libc::c_int) {
    if fd >= 0 {
        unsafe {
            libc::close(fd);
        }
    }
}

#[cfg(target_os = "linux")]
fn last_errno() -> i32 {
    unsafe { *libc::__errno_location() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::closed_execution_provider::ClosedExecutionMechanismId;
    use std::collections::BTreeMap;

    fn requirement(id: &str, parameters: BTreeMap<String, String>) -> ClosedExecutionRequirement {
        ClosedExecutionRequirement::new(ClosedExecutionMechanismId::parse(id).unwrap(), parameters)
            .unwrap()
    }

    fn requirement_set(
        requirements: Vec<ClosedExecutionRequirement>,
    ) -> ClosedExecutionRequirementSet {
        ClosedExecutionRequirementSet::new(requirements).unwrap()
    }

    #[tokio::test]
    async fn probe_is_open_vocabulary_support_only_and_verifier_bound() {
        let future_requirement_id = "external.closed_execution.future_attestation.v7";
        let requirements = requirement_set(vec![
            requirement(
                "synthi.closed_execution.capability.immutable_snapshot_sealing.v1",
                BTreeMap::new(),
            ),
            requirement(future_requirement_id, BTreeMap::new()),
        ]);
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let receipt = verifier
            .observe_closed_execution_capabilities(&challenge, &requirements)
            .await
            .unwrap();
        let validated = verifier
            .closed_execution_capability_receipt(&challenge, &receipt)
            .unwrap();
        assert_eq!(validated.probe_id(), receipt.probe_id());
        assert!(validated.policy_id().starts_with(POLICY_ID_PREFIX));
        assert!(validated.probe_id().starts_with(RECEIPT_ID_PREFIX));

        let json = serde_json::to_value(&receipt).unwrap();
        assert_eq!(json["evidenceAuthority"], RECEIPT_AUTHORITY);
        assert_eq!(json["acceptedForGpuHmr"], false);
        assert_eq!(json["gpuHmrSuccess"], false);
        assert_eq!(json["canAuthorizeBuild"], false);
        assert_eq!(json["canSatisfyClosedExecution"], false);
        assert_eq!(json["canSatisfyRuntimeProof"], false);
        assert_eq!(
            json["observations"].as_array().unwrap().len(),
            requirements.requirements().len()
        );
        assert_eq!(
            json["requirementSet"]["requirementSetIdentity"],
            requirements.identity().as_str()
        );
        let serialized = serde_json::to_string(&json).unwrap();
        for forbidden in [
            "projectId",
            "repository",
            "targetId",
            "profileId",
            "fixtureId",
            "backend",
            "engine",
            "framework",
        ] {
            assert!(!serialized.contains(forbidden));
        }
        assert_eq!(
            receipt.required_mechanics_observed(),
            receipt.blocking_gaps().is_empty()
        );
        assert!(receipt.observations.iter().all(|observation| {
            observation.outcome != CapabilityObservationOutcome::ProbeFailed
        }));
        let future_observation = receipt
            .observations
            .iter()
            .find(|observation| observation.capability_id == future_requirement_id)
            .unwrap();
        assert_eq!(
            future_observation.outcome,
            CapabilityObservationOutcome::NotObserved
        );
        assert!(receipt
            .blocking_gaps()
            .iter()
            .any(|gap| gap.contains(future_requirement_id)));

        #[cfg(target_os = "linux")]
        {
            assert_eq!(json["probeTransport"], PROBE_TRANSPORT);
            assert_ne!(json["probeProcessId"], std::process::id());

            let wire = LinuxCapabilityProbeWire {
                magic: PROBE_WIRE_MAGIC,
                version: 1,
                process_id: 42,
                reserved: 0,
                results: [RESULT_OBSERVED; PROBE_WIRE_V1_CAPABILITY_COUNT],
            };
            assert_eq!(
                decode_linux_probe_wire(&encode_linux_probe_wire(&wire)),
                wire
            );

            for fd in [0, 7, 198, libc::c_int::MAX] {
                let mut path = [0u8; 64];
                let encoded = proc_self_fd_path(fd, &mut path).unwrap();
                assert_eq!(
                    std::ffi::CStr::from_bytes_with_nul(encoded)
                        .unwrap()
                        .to_str()
                        .unwrap(),
                    format!("proc/self/fd/{fd}")
                );
            }
        }

        assert_eq!(
            verifier
                .observe_closed_execution_capabilities(&challenge, &requirements)
                .await
                .unwrap_err()
                .to_string(),
            "closed_execution_capability_probe_is_already_registered"
        );
    }

    #[tokio::test]
    async fn forged_or_cross_verifier_capability_receipts_are_rejected() {
        let requirements = requirement_set(vec![requirement(
            "external.closed_execution.observed_process_set.v3",
            BTreeMap::new(),
        )]);
        let mut first = BuildReceiptVerifier::new();
        let first_challenge = first.begin_transaction().unwrap();
        let receipt = first
            .observe_closed_execution_capabilities(&first_challenge, &requirements)
            .await
            .unwrap();

        let mut forged = receipt.clone();
        forged.accepted_for_gpu_hmr = true;
        assert_eq!(
            first
                .closed_execution_capability_receipt(&first_challenge, &forged)
                .unwrap_err()
                .to_string(),
            "closed_execution_capability_receipt_challenge_binding_mismatch"
        );

        let mut second = BuildReceiptVerifier::new();
        let second_challenge = second.begin_transaction().unwrap();
        assert_eq!(
            second
                .closed_execution_capability_receipt(&second_challenge, &receipt)
                .unwrap_err()
                .to_string(),
            "closed_execution_capability_receipt_challenge_binding_mismatch"
        );
    }

    #[test]
    fn serialized_success_fields_and_observation_mutations_fail_integrity() {
        let mut scoped_parameters = BTreeMap::new();
        scoped_parameters.insert("scope".to_string(), "descendant-process-set".to_string());
        let requirements = requirement_set(vec![
            requirement(
                "external.closed_execution.observed_process_set.v3",
                BTreeMap::new(),
            ),
            requirement(
                "external.closed_execution.observed_process_set.v3",
                scoped_parameters,
            ),
        ]);
        let observations = requirements
            .requirements()
            .iter()
            .map(|requirement| observation_from_result(requirement, RESULT_OBSERVED))
            .collect::<Vec<_>>();
        let policy_id = derive_policy_id(&requirements);
        let probe_id = derive_probe_id(&policy_id, PROBE_TRANSPORT, Some(7), &observations);
        let mut receipt = ObservedClosedExecutionCapabilitiesReceipt {
            schema_version: RECEIPT_SCHEMA_VERSION.to_string(),
            evidence_authority: RECEIPT_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_authorize_build: false,
            can_satisfy_closed_execution: false,
            can_satisfy_runtime_proof: false,
            observer_id: "observer".to_string(),
            clock_id: "clock".to_string(),
            challenge_id: "challenge".to_string(),
            challenge_expires_monotonic_ns: 4,
            policy_schema_version: POLICY_SCHEMA_VERSION.to_string(),
            policy_id,
            requirement_set: requirements.clone(),
            probe_transport: PROBE_TRANSPORT.to_string(),
            probe_process_id: Some(7),
            probe_started_monotonic_ns: 1,
            probe_completed_monotonic_ns: 2,
            probe_id,
            binding_id: String::new(),
            blocking_gaps: derive_blocking_gaps(&observations),
            observations,
        };
        receipt.binding_id = derive_binding_id(
            &receipt.probe_id,
            &receipt.observer_id,
            &receipt.clock_id,
            &receipt.challenge_id,
            receipt.challenge_expires_monotonic_ns,
            receipt.probe_started_monotonic_ns,
            receipt.probe_completed_monotonic_ns,
        );
        assert!(receipt.is_self_consistent());

        let mut success_claim = receipt.clone();
        success_claim.can_authorize_build = true;
        assert!(!success_claim.is_self_consistent());

        let mut mutated_observation = receipt.clone();
        mutated_observation.observations[0].evidence_code = "kernel_mechanic_observed".repeat(2);
        assert!(!mutated_observation.is_self_consistent());

        let mut removed_gap = receipt.clone();
        removed_gap.observations[0] =
            observation_from_result(&requirements.requirements()[0], RESULT_PREREQUISITE_MISSING);
        assert!(!removed_gap.is_self_consistent());

        let replacement_requirements = requirement_set(vec![requirement(
            "external.closed_execution.different_obligation.v1",
            BTreeMap::new(),
        )]);
        let mut replaced_policy = receipt;
        replaced_policy.requirement_set = replacement_requirements;
        assert!(!replaced_policy.is_self_consistent());
    }

    #[test]
    fn provider_catalog_does_not_define_generic_requirement_policy() {
        let capability_id = "external.closed_execution.parameterized_mechanic.v4";
        let unparameterized = requirement(capability_id, BTreeMap::new());
        let mut parameters = BTreeMap::new();
        parameters.insert("mode".to_string(), "strict".to_string());
        let parameterized = requirement(capability_id, parameters);
        let requirements = requirement_set(vec![parameterized, unparameterized]);
        let raw = RawCapabilityProbe {
            transport: "test_probe_transport_v1",
            process_id: Some(11),
            results: vec![RawCapabilityResult {
                capability_id,
                result: RESULT_OBSERVED,
            }],
        };

        let observations = observations_from_raw(&raw, &requirements);
        assert_eq!(observations.len(), 2);
        assert_eq!(
            observations
                .iter()
                .filter(|observation| {
                    observation.outcome == CapabilityObservationOutcome::Observed
                })
                .count(),
            1
        );
        assert_eq!(
            observations
                .iter()
                .filter(|observation| {
                    observation.outcome == CapabilityObservationOutcome::NotObserved
                })
                .count(),
            1
        );
        assert_ne!(
            observations[0].requirement_identity,
            observations[1].requirement_identity
        );
        let gaps = derive_blocking_gaps(&observations);
        let missing = observations
            .iter()
            .find(|observation| observation.outcome == CapabilityObservationOutcome::NotObserved)
            .unwrap();
        assert_eq!(gaps.len(), 1);
        assert!(gaps[0].contains(&missing.requirement_identity));
    }
}
