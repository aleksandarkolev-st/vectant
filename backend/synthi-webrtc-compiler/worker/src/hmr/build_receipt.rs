use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::time::{Duration, Instant};

use super::build_manifest::{
    BuildManifest, RELOAD_ARTIFACT_INPUT_ID_PREFIX, RELOAD_ARTIFACT_ROLE_ID_PREFIX,
};

mod command_observer;

pub(crate) use command_observer::{ObservedBuildCommandOutcome, StdinStdoutBuildStepPlan};

pub const OBSERVED_BUILD_STEP_RECEIPT_SCHEMA_VERSION: &str =
    "synthi.observed_build_step_receipt.v2";
pub const OBSERVED_BUILD_STEP_RECEIPT_ID_PREFIX: &str = "build-step-receipt:sha256:";
pub const OBSERVED_BUILD_STEP_RECEIPT_AUTHORITY: &str =
    "verifier_sealed_build_observation_only_not_loader_runtime_or_gpu_hmr_proof";
pub const VERIFIED_RELOAD_BUILD_TRANSACTION_SCHEMA_VERSION: &str =
    "synthi.verified_reload_build_transaction.v2";
pub const VERIFIED_RELOAD_BUILD_TRANSACTION_ID_PREFIX: &str =
    "verified-build-transaction:sha256:";
pub const VERIFIED_RELOAD_BUILD_TRANSACTION_AUTHORITY: &str =
    "verified_build_graph_observations_only_not_loader_runtime_or_gpu_hmr_proof";
const BUILD_RECEIPT_OBSERVER_ID_PREFIX: &str = "build-observer:sha256:";
const BUILD_RECEIPT_CLOCK_ID_PREFIX: &str = "build-clock:sha256:";
const BUILD_TRANSACTION_CHALLENGE_ID_PREFIX: &str = "build-challenge:sha256:";
const DEFAULT_BUILD_TRANSACTION_CHALLENGE_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const MAX_BUILD_TRANSACTION_CHALLENGE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const OBSERVED_BUILD_INPUT_CONSUMPTION_PROOF: &str =
    "observer_owned_input_pipe_drained_after_boundary_quiescence_v1";

/// A single-use challenge minted by one in-process build observer.
///
/// The fields are private and the type is not deserializable. A serialized
/// receipt cannot recreate an active challenge or cross an observer instance.
/// Final artifact bytes are intentionally bound at terminal verification,
/// because their content hashes do not exist when this window is issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildTransactionChallenge {
    challenge_id: String,
    observer_id: String,
    clock_id: String,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
}

impl BuildTransactionChallenge {
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }

    pub fn expires_monotonic_ns(&self) -> u64 {
        self.expires_monotonic_ns
    }
}

#[derive(Debug, Clone)]
struct ActiveChallenge {
    observer_id: String,
    clock_id: String,
    issued_monotonic_ns: u64,
    expires_monotonic_ns: u64,
    registered_receipt_ids: HashSet<String>,
}

/// Owns freshness and clock state for build-observation receipts.
///
/// Production receipts can only be minted by observer-owned execution methods
/// in this module. Callers provide command intent and input bytes, never status,
/// output hashes, timings, or a prebuilt process result.
#[derive(Debug)]
pub struct BuildReceiptVerifier {
    observer_id: String,
    clock_id: String,
    origin: Instant,
    challenge_ttl_ns: u64,
    active_challenges: HashMap<String, ActiveChallenge>,
}

impl Default for BuildReceiptVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl BuildReceiptVerifier {
    pub fn new() -> Self {
        Self::from_challenge_ttl_ns(DEFAULT_BUILD_TRANSACTION_CHALLENGE_TTL.as_nanos() as u64)
    }

    pub fn with_challenge_ttl(challenge_ttl: Duration) -> Result<Self, BuildReceiptError> {
        if challenge_ttl.is_zero() || challenge_ttl > MAX_BUILD_TRANSACTION_CHALLENGE_TTL {
            return Err(BuildReceiptError::new(
                "build_transaction_challenge_ttl_is_invalid",
            ));
        }
        let challenge_ttl_ns = monotonic_duration_ns(challenge_ttl)?;
        Ok(Self::from_challenge_ttl_ns(challenge_ttl_ns))
    }

    fn from_challenge_ttl_ns(challenge_ttl_ns: u64) -> Self {
        let observer_nonce = random_nonce();
        let clock_nonce = random_nonce();
        let process_id = std::process::id();
        let observer_id = prefixed_hash(
            BUILD_RECEIPT_OBSERVER_ID_PREFIX,
            b"synthi.build_receipt_observer.v1",
            &[&observer_nonce, &process_id.to_be_bytes()],
        );
        let clock_id = prefixed_hash(
            BUILD_RECEIPT_CLOCK_ID_PREFIX,
            b"synthi.build_receipt_clock.v1",
            &[observer_id.as_bytes(), &clock_nonce],
        );
        Self {
            observer_id,
            clock_id,
            origin: Instant::now(),
            challenge_ttl_ns,
            active_challenges: HashMap::new(),
        }
    }

    pub fn begin_transaction(&mut self) -> Result<BuildTransactionChallenge, BuildReceiptError> {
        let issued_monotonic_ns = self.monotonic_now_ns()?;
        let expires_monotonic_ns = issued_monotonic_ns
            .checked_add(self.challenge_ttl_ns)
            .ok_or_else(|| {
                BuildReceiptError::new("build_transaction_challenge_deadline_is_invalid")
            })?;
        let nonce = random_nonce();
        let challenge_id = prefixed_hash(
            BUILD_TRANSACTION_CHALLENGE_ID_PREFIX,
            b"synthi.build_transaction_challenge.v2",
            &[
                self.observer_id.as_bytes(),
                self.clock_id.as_bytes(),
                &issued_monotonic_ns.to_be_bytes(),
                &expires_monotonic_ns.to_be_bytes(),
                &nonce,
            ],
        );
        let active = ActiveChallenge {
            observer_id: self.observer_id.clone(),
            clock_id: self.clock_id.clone(),
            issued_monotonic_ns,
            expires_monotonic_ns,
            registered_receipt_ids: HashSet::new(),
        };
        self.active_challenges
            .insert(challenge_id.clone(), active);
        Ok(BuildTransactionChallenge {
            challenge_id,
            observer_id: self.observer_id.clone(),
            clock_id: self.clock_id.clone(),
            issued_monotonic_ns,
            expires_monotonic_ns,
        })
    }

    pub fn verify_reload_transaction(
        &mut self,
        challenge: &BuildTransactionChallenge,
        manifest: &BuildManifest,
        receipts: &[ObservedBuildStepReceipt],
    ) -> Result<VerifiedReloadBuildTransactionReceipt, BuildReceiptError> {
        let verifier_now_monotonic_ns = self.monotonic_now_ns()?;
        let active = self
            .active_challenges
            .remove(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        if challenge.observer_id != self.observer_id
            || challenge.clock_id != self.clock_id
            || challenge.observer_id != active.observer_id
            || challenge.clock_id != active.clock_id
            || challenge.issued_monotonic_ns != active.issued_monotonic_ns
            || challenge.expires_monotonic_ns != active.expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_transaction_challenge_observer_binding_mismatch",
            ));
        }
        if verifier_now_monotonic_ns >= challenge.expires_monotonic_ns {
            return Err(BuildReceiptError::new(
                "build_transaction_challenge_expired",
            ));
        }
        if active.registered_receipt_ids.len() != receipts.len()
            || receipts.iter().any(|receipt| {
                !active
                    .registered_receipt_ids
                    .contains(receipt.receipt_id.as_str())
            })
        {
            return Err(BuildReceiptError::new(
                "build_transaction_receipt_registry_mismatch",
            ));
        }
        let verified = verify_reload_transaction_build_receipts(
            challenge,
            manifest,
            receipts,
            verifier_now_monotonic_ns,
        )?;
        Ok(verified)
    }

    fn monotonic_now_ns(&self) -> Result<u64, BuildReceiptError> {
        monotonic_duration_ns(self.origin.elapsed())
    }

    fn register_observed_receipt(
        &mut self,
        challenge: &BuildTransactionChallenge,
        receipt: &ObservedBuildStepReceipt,
    ) -> Result<(), BuildReceiptError> {
        let verifier_now_monotonic_ns = self.monotonic_now_ns()?;
        let active = self
            .active_challenges
            .get(challenge.challenge_id.as_str())
            .ok_or_else(|| BuildReceiptError::new("build_transaction_challenge_is_not_active"))?;
        if verifier_now_monotonic_ns >= active.expires_monotonic_ns {
            self.active_challenges
                .remove(challenge.challenge_id.as_str());
            return Err(BuildReceiptError::new(
                "build_transaction_challenge_expired",
            ));
        }
        if challenge.observer_id != self.observer_id
            || challenge.clock_id != self.clock_id
            || challenge.observer_id != active.observer_id
            || challenge.clock_id != active.clock_id
            || challenge.issued_monotonic_ns != active.issued_monotonic_ns
            || challenge.expires_monotonic_ns != active.expires_monotonic_ns
            || receipt.observer_id != challenge.observer_id
            || receipt.clock_id != challenge.clock_id
            || receipt.challenge_id != challenge.challenge_id
            || receipt.challenge_expires_monotonic_ns != challenge.expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_challenge_binding_mismatch",
            ));
        }
        validate_sealed_step_receipt(receipt)?;
        if receipt.started_monotonic_ns < challenge.issued_monotonic_ns
            || receipt.completed_monotonic_ns < receipt.started_monotonic_ns
            || receipt.completed_monotonic_ns > verifier_now_monotonic_ns
            || receipt.completed_monotonic_ns >= challenge.expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_monotonic_interval_is_invalid",
            ));
        }
        let active = self
            .active_challenges
            .get_mut(challenge.challenge_id.as_str())
            .expect("active challenge was validated above");
        if !active
            .registered_receipt_ids
            .insert(receipt.receipt_id.clone())
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_is_already_registered",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBuildInputReceipt {
    input_id: String,
    content_hash: String,
    byte_length: u64,
    consumption_proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBuildOutputReference {
    producer_receipt_id: String,
    output_ordinal: u32,
    content_hash: String,
    byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBuildOutputReceipt {
    output_ordinal: u32,
    /// Observer-owned transport closure, not semantic causality and not proof
    /// that the intended execution lineage was the only possible consumer.
    consumed_input_ids: Vec<String>,
    /// Reserved for verifier-materialized upstream transports. Production
    /// command observers currently emit no caller-declared upstream edges.
    consumed_upstream_outputs: Vec<ObservedBuildOutputReference>,
    content_hash: String,
    byte_length: u64,
}

/// A sealed build-step observation.
///
/// It is serialize-only and all fields are private. Its authority ends at the
/// observed build graph; explicit false flags prevent report consumers from
/// treating it as load, runtime, dispatch, visual, or GPU-HMR acceptance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedBuildStepReceipt {
    schema_version: String,
    evidence_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
    can_satisfy_build_transaction: bool,
    input_transport_bound_to_execution_boundary: bool,
    execution_policy_authorized: bool,
    execution_runtime_closure_observed: bool,
    observer_id: String,
    clock_id: String,
    challenge_id: String,
    challenge_expires_monotonic_ns: u64,
    receipt_id: String,
    executor_hash: String,
    execution_boundary: String,
    invocation_hash: String,
    started_monotonic_ns: u64,
    completed_monotonic_ns: u64,
    inputs: Vec<ObservedBuildInputReceipt>,
    outputs: Vec<ObservedBuildOutputReceipt>,
}

impl ObservedBuildStepReceipt {
    pub fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub fn invocation_hash(&self) -> &str {
        &self.invocation_hash
    }

    pub fn evidence_authority(&self) -> &str {
        &self.evidence_authority
    }

    pub(crate) fn can_satisfy_build_transaction(&self) -> bool {
        self.can_satisfy_build_transaction
    }

    pub(crate) fn output_reference(
        &self,
        output_ordinal: u32,
    ) -> Option<ObservedBuildOutputReference> {
        self.outputs
            .iter()
            .find(|output| output.output_ordinal == output_ordinal)
            .map(|output| ObservedBuildOutputReference {
                producer_receipt_id: self.receipt_id.clone(),
                output_ordinal,
                content_hash: output.content_hash.clone(),
                byte_length: output.byte_length,
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedArtifactBuildBinding {
    role_id: String,
    build_step_receipt_id: String,
    invocation_hash: String,
    output_ordinal: u32,
    artifact_hash: String,
    byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedReloadBuildTransactionReceipt {
    schema_version: String,
    evidence_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
    execution_policy_authorized: bool,
    execution_runtime_closure_observed: bool,
    receipt_id: String,
    observer_id: String,
    clock_id: String,
    challenge_id: String,
    challenge_expires_monotonic_ns: u64,
    reload_transaction_commitment_id: String,
    build_step_receipt_ids: Vec<String>,
    artifact_bindings: Vec<VerifiedArtifactBuildBinding>,
}

impl VerifiedReloadBuildTransactionReceipt {
    pub fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub fn evidence_authority(&self) -> &str {
        &self.evidence_authority
    }

    pub fn reload_transaction_commitment_id(&self) -> &str {
        &self.reload_transaction_commitment_id
    }

    pub fn artifact_bindings(&self) -> &[VerifiedArtifactBuildBinding] {
        &self.artifact_bindings
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildReceiptError {
    reason: String,
}

impl BuildReceiptError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for BuildReceiptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for BuildReceiptError {}

fn verify_reload_transaction_build_receipts(
    challenge: &BuildTransactionChallenge,
    manifest: &BuildManifest,
    receipts: &[ObservedBuildStepReceipt],
    verifier_now_monotonic_ns: u64,
) -> Result<VerifiedReloadBuildTransactionReceipt, BuildReceiptError> {
    let reload_transaction_commitment_id = manifest
        .reload_transaction_commitment_identity()
        .map_err(|error| BuildReceiptError::new(error.to_string()))?;
    if receipts.is_empty() {
        return Err(BuildReceiptError::new("build_step_receipts_are_missing"));
    }
    let artifacts = manifest
        .artifacts
        .as_ref()
        .expect("strict commitment validation requires explicit artifacts");

    let mut receipt_ids = HashSet::with_capacity(receipts.len());
    let mut receipts_by_invocation = HashMap::with_capacity(receipts.len());
    let mut observed_inputs: HashMap<&str, (&str, u64)> = HashMap::new();
    let mut outputs_by_invocation = HashMap::new();
    let mut outputs_by_receipt = HashMap::new();
    for receipt in receipts {
        validate_sealed_step_receipt(receipt)?;
        if !receipt.can_satisfy_build_transaction
            || !receipt.input_transport_bound_to_execution_boundary
            || !receipt.execution_policy_authorized
            || !receipt.execution_runtime_closure_observed
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_dependency_authority_is_insufficient",
            ));
        }
        if receipt.observer_id != challenge.observer_id
            || receipt.clock_id != challenge.clock_id
            || receipt.challenge_id != challenge.challenge_id
            || receipt.challenge_expires_monotonic_ns != challenge.expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_challenge_binding_mismatch",
            ));
        }
        if receipt.started_monotonic_ns < challenge.issued_monotonic_ns
            || receipt.completed_monotonic_ns < receipt.started_monotonic_ns
            || receipt.completed_monotonic_ns > verifier_now_monotonic_ns
            || receipt.completed_monotonic_ns >= challenge.expires_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_step_receipt_monotonic_interval_is_invalid",
            ));
        }
        if !receipt_ids.insert(receipt.receipt_id.as_str()) {
            return Err(BuildReceiptError::new(
                "build_transaction_contains_duplicate_receipt_id",
            ));
        }
        if receipts_by_invocation
            .insert(receipt.invocation_hash.as_str(), receipt)
            .is_some()
        {
            return Err(BuildReceiptError::new(
                "build_transaction_contains_ambiguous_invocation",
            ));
        }
        for input in &receipt.inputs {
            match observed_inputs.insert(
                input.input_id.as_str(),
                (input.content_hash.as_str(), input.byte_length),
            ) {
                Some(previous)
                    if previous != (input.content_hash.as_str(), input.byte_length) =>
                {
                    return Err(BuildReceiptError::new(
                        "build_transaction_input_observations_conflict",
                    ));
                }
                _ => {}
            }
        }
        for output in &receipt.outputs {
            if outputs_by_invocation
                .insert(
                    (receipt.invocation_hash.as_str(), output.output_ordinal),
                    (receipt, output),
                )
                .is_some()
                || outputs_by_receipt
                    .insert(
                        (receipt.receipt_id.as_str(), output.output_ordinal),
                        (receipt, output),
                    )
                    .is_some()
            {
                return Err(BuildReceiptError::new(
                    "build_transaction_output_observation_is_ambiguous",
                ));
            }
        }
    }

    for receipt in receipts {
        for output in &receipt.outputs {
            for reference in &output.consumed_upstream_outputs {
                let (producer_receipt, producer_output) = outputs_by_receipt
                    .get(&(
                        reference.producer_receipt_id.as_str(),
                        reference.output_ordinal,
                    ))
                    .copied()
                    .ok_or_else(|| {
                        BuildReceiptError::new(
                            "build_transaction_upstream_output_reference_is_missing",
                        )
                    })?;
                if producer_output.content_hash != reference.content_hash
                    || producer_output.byte_length != reference.byte_length
                {
                    return Err(BuildReceiptError::new(
                        "build_transaction_upstream_output_reference_mismatch",
                    ));
                }
                if receipt.started_monotonic_ns < producer_receipt.completed_monotonic_ns {
                    return Err(BuildReceiptError::new(
                        "build_transaction_dependency_execution_order_is_invalid",
                    ));
                }
            }
        }
    }

    struct RoleOutputBinding<'a> {
        receipt: &'a ObservedBuildStepReceipt,
        output: &'a ObservedBuildOutputReceipt,
    }

    let mut declared_inputs = HashMap::new();
    let mut used_outputs = HashSet::with_capacity(artifacts.len());
    let mut role_output_bindings = HashMap::with_capacity(artifacts.len());
    let mut artifact_bindings = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let role = artifact
            .reload_role
            .as_ref()
            .expect("strict commitment validation requires every role");
        validate_prefixed_hash(
            &role.role_id,
            RELOAD_ARTIFACT_ROLE_ID_PREFIX,
            "build_transaction_role_id_is_invalid",
        )?;
        let receipt = receipts_by_invocation
            .get(role.producer_step_hash.as_str())
            .copied()
            .ok_or_else(|| {
                BuildReceiptError::new("build_transaction_producer_receipt_is_missing")
            })?;
        let output_key = (role.producer_step_hash.as_str(), role.output_ordinal);
        let (_, output) = outputs_by_invocation
            .get(&output_key)
            .copied()
            .ok_or_else(|| {
                BuildReceiptError::new("build_transaction_role_output_is_missing")
            })?;
        if !used_outputs.insert(output_key) {
            return Err(BuildReceiptError::new(
                "build_transaction_role_output_is_reused",
            ));
        }
        if output.content_hash != artifact.artifact_hash {
            return Err(BuildReceiptError::new(
                "build_transaction_artifact_hash_mismatch",
            ));
        }
        if artifact
            .byte_length
            .is_some_and(|length| length != output.byte_length)
        {
            return Err(BuildReceiptError::new(
                "build_transaction_artifact_byte_length_mismatch",
            ));
        }

        let direct_inputs = output
            .consumed_input_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        if role
            .primary_input_ids
            .iter()
            .any(|input_id| !direct_inputs.contains(input_id.as_str()))
        {
            return Err(BuildReceiptError::new(
                "build_transaction_primary_input_not_observed_at_producer",
            ));
        }
        let role_inputs = role
            .dependency_inputs
            .iter()
            .map(|input| (input.input_id.as_str(), input.content_hash.as_str()))
            .collect::<HashMap<_, _>>();
        for direct_input in &output.consumed_input_ids {
            if !role_inputs.contains_key(direct_input.as_str()) {
                return Err(BuildReceiptError::new(
                    "build_transaction_direct_input_missing_from_role_closure",
                ));
            }
        }
        for input in &role.dependency_inputs {
            match observed_inputs.get(input.input_id.as_str()) {
                Some((content_hash, _)) if *content_hash == input.content_hash => {}
                Some(_) => {
                    return Err(BuildReceiptError::new(
                        "build_transaction_input_hash_mismatch",
                    ));
                }
                None => {
                    return Err(BuildReceiptError::new(
                        "build_transaction_input_observation_is_missing",
                    ));
                }
            }
            match declared_inputs.insert(input.input_id.as_str(), input.content_hash.as_str()) {
                Some(previous) if previous != input.content_hash => {
                    return Err(BuildReceiptError::new(
                        "build_transaction_declared_input_hashes_conflict",
                    ));
                }
                _ => {}
            }
        }

        role_output_bindings.insert(
            role.role_id.as_str(),
            RoleOutputBinding { receipt, output },
        );
        artifact_bindings.push(VerifiedArtifactBuildBinding {
            role_id: role.role_id.clone(),
            build_step_receipt_id: receipt.receipt_id.clone(),
            invocation_hash: receipt.invocation_hash.clone(),
            output_ordinal: role.output_ordinal,
            artifact_hash: artifact.artifact_hash.clone(),
            byte_length: output.byte_length,
        });
    }

    for artifact in artifacts {
        let role = artifact
            .reload_role
            .as_ref()
            .expect("strict commitment validation requires every role");
        let binding = role_output_bindings
            .get(role.role_id.as_str())
            .expect("every role was bound above");
        if binding.output.consumed_upstream_outputs.len()
            != role.dependency_role_ids.len()
        {
            return Err(BuildReceiptError::new(
                "build_transaction_dependency_edge_count_mismatch",
            ));
        }
        for dependency_role_id in &role.dependency_role_ids {
            let dependency = role_output_bindings
                .get(dependency_role_id.as_str())
                .ok_or_else(|| {
                    BuildReceiptError::new(
                        "build_transaction_dependency_role_output_is_missing",
                    )
                })?;
            let observed = binding.output.consumed_upstream_outputs.iter().any(
                |reference| {
                    reference.producer_receipt_id == dependency.receipt.receipt_id
                        && reference.output_ordinal == dependency.output.output_ordinal
                        && reference.content_hash == dependency.output.content_hash
                        && reference.byte_length == dependency.output.byte_length
                },
            );
            if !observed {
                return Err(BuildReceiptError::new(
                    "build_transaction_dependency_edge_is_unobserved",
                ));
            }
        }
    }

    let mut reachable_inputs_by_role: HashMap<&str, HashMap<&str, (&str, u64)>> =
        HashMap::with_capacity(artifacts.len());
    while reachable_inputs_by_role.len() < artifacts.len() {
        let mut progressed = false;
        for artifact in artifacts {
            let role = artifact
                .reload_role
                .as_ref()
                .expect("strict commitment validation requires every role");
            if reachable_inputs_by_role.contains_key(role.role_id.as_str())
                || role
                    .dependency_role_ids
                    .iter()
                    .any(|dependency| !reachable_inputs_by_role.contains_key(dependency.as_str()))
            {
                continue;
            }

            let binding = role_output_bindings
                .get(role.role_id.as_str())
                .expect("every role was bound above");
            let receipt_inputs = binding
                .receipt
                .inputs
                .iter()
                .map(|input| {
                    (
                        input.input_id.as_str(),
                        (input.content_hash.as_str(), input.byte_length),
                    )
                })
                .collect::<HashMap<_, _>>();
            let mut reachable_inputs = HashMap::new();
            for input_id in &binding.output.consumed_input_ids {
                let observed = receipt_inputs.get(input_id.as_str()).copied().ok_or_else(|| {
                    BuildReceiptError::new("build_transaction_direct_input_observation_is_missing")
                })?;
                reachable_inputs.insert(input_id.as_str(), observed);
            }
            for dependency_role_id in &role.dependency_role_ids {
                let dependency_inputs = reachable_inputs_by_role
                    .get(dependency_role_id.as_str())
                    .expect("dependency reachability was checked above");
                for (input_id, observed) in dependency_inputs {
                    match reachable_inputs.insert(*input_id, *observed) {
                        Some(previous) if previous != *observed => {
                            return Err(BuildReceiptError::new(
                                "build_transaction_reachable_input_observations_conflict",
                            ));
                        }
                        _ => {}
                    }
                }
            }

            if reachable_inputs.len() != role.dependency_inputs.len() {
                return Err(BuildReceiptError::new(
                    "build_transaction_role_input_reachability_mismatch",
                ));
            }
            for declared in &role.dependency_inputs {
                match reachable_inputs.get(declared.input_id.as_str()) {
                    Some((content_hash, _)) if *content_hash == declared.content_hash => {}
                    Some(_) => {
                        return Err(BuildReceiptError::new(
                            "build_transaction_reachable_input_hash_mismatch",
                        ));
                    }
                    None => {
                        return Err(BuildReceiptError::new(
                            "build_transaction_role_input_is_not_reachable",
                        ));
                    }
                }
            }
            reachable_inputs_by_role.insert(role.role_id.as_str(), reachable_inputs);
            progressed = true;
        }
        if !progressed {
            return Err(BuildReceiptError::new(
                "build_transaction_role_input_reachability_is_cyclic",
            ));
        }
    }

    if used_outputs.len() != outputs_by_invocation.len() {
        return Err(BuildReceiptError::new(
            "build_transaction_contains_unbound_output",
        ));
    }
    if declared_inputs.len() != observed_inputs.len()
        || observed_inputs
            .keys()
            .any(|input_id| !declared_inputs.contains_key(input_id))
    {
        return Err(BuildReceiptError::new(
            "build_transaction_contains_undeclared_input",
        ));
    }

    artifact_bindings.sort_by(|left, right| left.role_id.cmp(&right.role_id));
    let mut build_step_receipt_ids = receipt_ids
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    build_step_receipt_ids.sort();
    let execution_policy_authorized = receipts
        .iter()
        .all(|receipt| receipt.execution_policy_authorized);
    let execution_runtime_closure_observed = receipts
        .iter()
        .all(|receipt| receipt.execution_runtime_closure_observed);
    let receipt_id = derive_transaction_receipt_id(
        challenge,
        &reload_transaction_commitment_id,
        &build_step_receipt_ids,
        &artifact_bindings,
        execution_policy_authorized,
        execution_runtime_closure_observed,
    );
    Ok(VerifiedReloadBuildTransactionReceipt {
        schema_version: VERIFIED_RELOAD_BUILD_TRANSACTION_SCHEMA_VERSION.to_string(),
        evidence_authority: VERIFIED_RELOAD_BUILD_TRANSACTION_AUTHORITY.to_string(),
        accepted_for_gpu_hmr: false,
        gpu_hmr_success: false,
        can_satisfy_runtime_proof: false,
        execution_policy_authorized,
        execution_runtime_closure_observed,
        receipt_id,
        observer_id: challenge.observer_id.clone(),
        clock_id: challenge.clock_id.clone(),
        challenge_id: challenge.challenge_id.clone(),
        challenge_expires_monotonic_ns: challenge.expires_monotonic_ns,
        reload_transaction_commitment_id,
        build_step_receipt_ids,
        artifact_bindings,
    })
}

fn validate_sealed_step_receipt(receipt: &ObservedBuildStepReceipt) -> Result<(), BuildReceiptError> {
    if receipt.schema_version != OBSERVED_BUILD_STEP_RECEIPT_SCHEMA_VERSION
        || receipt.evidence_authority != OBSERVED_BUILD_STEP_RECEIPT_AUTHORITY
        || receipt.accepted_for_gpu_hmr
        || receipt.gpu_hmr_success
        || receipt.can_satisfy_runtime_proof
    {
        return Err(BuildReceiptError::new(
            "build_step_receipt_schema_or_authority_is_invalid",
        ));
    }
    validate_prefixed_hash(
        &receipt.observer_id,
        BUILD_RECEIPT_OBSERVER_ID_PREFIX,
        "build_step_observer_id_is_invalid",
    )?;
    validate_prefixed_hash(
        &receipt.clock_id,
        BUILD_RECEIPT_CLOCK_ID_PREFIX,
        "build_step_clock_id_is_invalid",
    )?;
    validate_prefixed_hash(
        &receipt.challenge_id,
        BUILD_TRANSACTION_CHALLENGE_ID_PREFIX,
        "build_step_challenge_id_is_invalid",
    )?;
    if receipt.challenge_expires_monotonic_ns <= receipt.completed_monotonic_ns {
        return Err(BuildReceiptError::new(
            "build_step_challenge_expiry_is_invalid",
        ));
    }
    validate_prefixed_hash(
        &receipt.receipt_id,
        OBSERVED_BUILD_STEP_RECEIPT_ID_PREFIX,
        "build_step_receipt_id_is_invalid",
    )?;
    validate_canonical_hash(
        &receipt.executor_hash,
        "build_step_executor_hash_is_invalid",
    )?;
    if receipt.execution_boundary.is_empty() || receipt.execution_boundary.contains('\0') {
        return Err(BuildReceiptError::new(
            "build_step_execution_boundary_is_invalid",
        ));
    }
    validate_canonical_hash(
        &receipt.invocation_hash,
        "build_step_invocation_hash_is_invalid",
    )?;
    if receipt.outputs.is_empty() {
        return Err(BuildReceiptError::new("build_step_outputs_are_missing"));
    }
    let mut canonical_inputs = receipt.inputs.clone();
    canonical_inputs.sort_by(|left, right| left.input_id.cmp(&right.input_id));
    if canonical_inputs != receipt.inputs {
        return Err(BuildReceiptError::new(
            "build_step_inputs_are_not_canonical",
        ));
    }
    if canonical_inputs
        .windows(2)
        .any(|pair| pair[0].input_id == pair[1].input_id)
    {
        return Err(BuildReceiptError::new(
            "build_step_contains_duplicate_input",
        ));
    }
    let input_ids = receipt
        .inputs
        .iter()
        .map(|input| input.input_id.as_str())
        .collect::<HashSet<_>>();
    for input in &receipt.inputs {
        validate_prefixed_hash(
            &input.input_id,
            RELOAD_ARTIFACT_INPUT_ID_PREFIX,
            "build_step_input_id_is_invalid",
        )?;
        validate_canonical_hash(
            &input.content_hash,
            "build_step_input_hash_is_invalid",
        )?;
        if input.consumption_proof != OBSERVED_BUILD_INPUT_CONSUMPTION_PROOF {
            return Err(BuildReceiptError::new(
                "build_step_input_consumption_proof_is_invalid",
            ));
        }
    }
    let mut canonical_outputs = receipt.outputs.clone();
    canonical_outputs.sort_by_key(|output| output.output_ordinal);
    if canonical_outputs != receipt.outputs {
        return Err(BuildReceiptError::new(
            "build_step_outputs_are_not_canonical",
        ));
    }
    if canonical_outputs
        .windows(2)
        .any(|pair| pair[0].output_ordinal == pair[1].output_ordinal)
    {
        return Err(BuildReceiptError::new(
            "build_step_contains_duplicate_output_ordinal",
        ));
    }
    let mut output_bound_input_ids = HashSet::new();
    for output in &receipt.outputs {
        validate_canonical_hash(
            &output.content_hash,
            "build_step_output_hash_is_invalid",
        )?;
        let mut direct = output.consumed_input_ids.clone();
        direct.sort();
        if direct != output.consumed_input_ids {
            return Err(BuildReceiptError::new(
                "build_step_output_inputs_are_not_canonical",
            ));
        }
        if direct.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(BuildReceiptError::new(
                "build_step_output_contains_duplicate_input",
            ));
        }
        for input_id in &output.consumed_input_ids {
            validate_prefixed_hash(
                input_id,
                RELOAD_ARTIFACT_INPUT_ID_PREFIX,
                "build_step_output_input_id_is_invalid",
            )?;
            if !input_ids.contains(input_id.as_str()) {
                return Err(BuildReceiptError::new(
                    "build_step_output_input_is_unobserved",
                ));
            }
            output_bound_input_ids.insert(input_id.as_str());
        }
        let mut upstream = output.consumed_upstream_outputs.clone();
        upstream.sort_by(|left, right| {
            left.producer_receipt_id
                .cmp(&right.producer_receipt_id)
                .then_with(|| left.output_ordinal.cmp(&right.output_ordinal))
        });
        if upstream != output.consumed_upstream_outputs {
            return Err(BuildReceiptError::new(
                "build_step_upstream_outputs_are_not_canonical",
            ));
        }
        if upstream.windows(2).any(|pair| {
            pair[0].producer_receipt_id == pair[1].producer_receipt_id
                && pair[0].output_ordinal == pair[1].output_ordinal
        }) {
            return Err(BuildReceiptError::new(
                "build_step_output_contains_duplicate_upstream_reference",
            ));
        }
        for reference in &upstream {
            validate_prefixed_hash(
                &reference.producer_receipt_id,
                OBSERVED_BUILD_STEP_RECEIPT_ID_PREFIX,
                "build_step_upstream_receipt_id_is_invalid",
            )?;
            validate_canonical_hash(
                &reference.content_hash,
                "build_step_upstream_output_hash_is_invalid",
            )?;
        }
    }
    if input_ids != output_bound_input_ids {
        return Err(BuildReceiptError::new(
            "build_step_contains_input_unbound_to_output",
        ));
    }
    let expected_receipt_id = derive_step_receipt_id(receipt);
    if receipt.receipt_id != expected_receipt_id {
        return Err(BuildReceiptError::new(
            "build_step_receipt_id_mismatch",
        ));
    }
    Ok(())
}

fn derive_step_receipt_id(receipt: &ObservedBuildStepReceipt) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        OBSERVED_BUILD_STEP_RECEIPT_SCHEMA_VERSION.as_bytes(),
    );
    hash_field(&mut hasher, receipt.observer_id.as_bytes());
    hash_field(&mut hasher, receipt.clock_id.as_bytes());
    hash_field(&mut hasher, receipt.challenge_id.as_bytes());
    hasher.update(receipt.challenge_expires_monotonic_ns.to_be_bytes());
    hash_field(&mut hasher, receipt.executor_hash.as_bytes());
    hash_field(&mut hasher, receipt.execution_boundary.as_bytes());
    hasher.update([receipt.can_satisfy_build_transaction as u8]);
    hasher.update([receipt.input_transport_bound_to_execution_boundary as u8]);
    hasher.update([receipt.execution_policy_authorized as u8]);
    hasher.update([receipt.execution_runtime_closure_observed as u8]);
    hash_field(&mut hasher, receipt.invocation_hash.as_bytes());
    hasher.update(receipt.started_monotonic_ns.to_be_bytes());
    hasher.update(receipt.completed_monotonic_ns.to_be_bytes());
    hasher.update((receipt.inputs.len() as u64).to_be_bytes());
    for input in &receipt.inputs {
        hash_field(&mut hasher, input.input_id.as_bytes());
        hash_field(&mut hasher, input.content_hash.as_bytes());
        hasher.update(input.byte_length.to_be_bytes());
        hash_field(&mut hasher, input.consumption_proof.as_bytes());
    }
    hasher.update((receipt.outputs.len() as u64).to_be_bytes());
    for output in &receipt.outputs {
        hasher.update(output.output_ordinal.to_be_bytes());
        hash_field(&mut hasher, output.content_hash.as_bytes());
        hasher.update(output.byte_length.to_be_bytes());
        hasher.update((output.consumed_input_ids.len() as u64).to_be_bytes());
        for input_id in &output.consumed_input_ids {
            hash_field(&mut hasher, input_id.as_bytes());
        }
        hasher.update(
            (output.consumed_upstream_outputs.len() as u64).to_be_bytes(),
        );
        for reference in &output.consumed_upstream_outputs {
            hash_field(&mut hasher, reference.producer_receipt_id.as_bytes());
            hasher.update(reference.output_ordinal.to_be_bytes());
            hash_field(&mut hasher, reference.content_hash.as_bytes());
            hasher.update(reference.byte_length.to_be_bytes());
        }
    }
    format!(
        "{OBSERVED_BUILD_STEP_RECEIPT_ID_PREFIX}{:x}",
        hasher.finalize()
    )
}

fn derive_transaction_receipt_id(
    challenge: &BuildTransactionChallenge,
    reload_transaction_commitment_id: &str,
    build_step_receipt_ids: &[String],
    artifact_bindings: &[VerifiedArtifactBuildBinding],
    execution_policy_authorized: bool,
    execution_runtime_closure_observed: bool,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        VERIFIED_RELOAD_BUILD_TRANSACTION_SCHEMA_VERSION.as_bytes(),
    );
    hash_field(&mut hasher, challenge.observer_id.as_bytes());
    hash_field(&mut hasher, challenge.clock_id.as_bytes());
    hash_field(&mut hasher, challenge.challenge_id.as_bytes());
    hasher.update(challenge.expires_monotonic_ns.to_be_bytes());
    hash_field(&mut hasher, reload_transaction_commitment_id.as_bytes());
    hasher.update([execution_policy_authorized as u8]);
    hasher.update([execution_runtime_closure_observed as u8]);
    hasher.update((build_step_receipt_ids.len() as u64).to_be_bytes());
    for receipt_id in build_step_receipt_ids {
        hash_field(&mut hasher, receipt_id.as_bytes());
    }
    hasher.update((artifact_bindings.len() as u64).to_be_bytes());
    for binding in artifact_bindings {
        hash_field(&mut hasher, binding.role_id.as_bytes());
        hash_field(&mut hasher, binding.build_step_receipt_id.as_bytes());
        hash_field(&mut hasher, binding.invocation_hash.as_bytes());
        hasher.update(binding.output_ordinal.to_be_bytes());
        hash_field(&mut hasher, binding.artifact_hash.as_bytes());
        hasher.update(binding.byte_length.to_be_bytes());
    }
    format!(
        "{VERIFIED_RELOAD_BUILD_TRANSACTION_ID_PREFIX}{:x}",
        hasher.finalize()
    )
}

fn random_nonce() -> [u8; 32] {
    let mut nonce = [0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

fn monotonic_duration_ns(duration: Duration) -> Result<u64, BuildReceiptError> {
    u64::try_from(duration.as_nanos())
        .map_err(|_| BuildReceiptError::new("build_receipt_monotonic_clock_overflow"))
}

fn prefixed_hash(prefix: &str, domain: &[u8], fields: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, domain);
    for field in fields {
        hash_field(&mut hasher, field);
    }
    format!("{prefix}{:x}", hasher.finalize())
}

fn validate_canonical_hash(value: &str, reason: &str) -> Result<(), BuildReceiptError> {
    validate_prefixed_hash(value, "sha256:", reason)
}

fn validate_prefixed_hash(
    value: &str,
    prefix: &str,
    reason: &str,
) -> Result<(), BuildReceiptError> {
    let valid = value.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    });
    if valid {
        Ok(())
    } else {
        Err(BuildReceiptError::new(reason))
    }
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

#[cfg(test)]
mod test_support {
    use super::*;
    use std::sync::Arc;

    #[derive(Debug, Clone)]
    pub(super) enum InvocationComponent {
        Literal(Arc<[u8]>),
        Input(String),
        Upstream(ObservedBuildOutputReference),
        Output(u32),
    }

    #[derive(Debug, Clone)]
    pub(super) struct InputBytes {
        pub input_id: String,
        pub locator: String,
        pub bytes: Arc<[u8]>,
    }

    #[derive(Debug, Clone)]
    pub(super) struct OutputBytes {
        pub output_ordinal: u32,
        pub consumed_input_ids: Vec<String>,
        pub consumed_upstream_outputs: Vec<ObservedBuildOutputReference>,
        pub locator: String,
        pub bytes: Arc<[u8]>,
    }

    #[derive(Debug, Clone)]
    pub(super) struct TestBuildObservation {
        pub executor_bytes: Arc<[u8]>,
        pub invocation_components: Vec<InvocationComponent>,
        pub started_monotonic_ns: u64,
        pub completed_monotonic_ns: u64,
        pub successful: bool,
        pub inputs: Vec<InputBytes>,
        pub outputs: Vec<OutputBytes>,
    }

    pub(super) fn output_reference(
        receipt: &ObservedBuildStepReceipt,
        output_ordinal: u32,
    ) -> ObservedBuildOutputReference {
        let output = receipt
            .outputs
            .iter()
            .find(|output| output.output_ordinal == output_ordinal)
            .expect("test output ordinal must exist");
        ObservedBuildOutputReference {
            producer_receipt_id: receipt.receipt_id.clone(),
            output_ordinal,
            content_hash: output.content_hash.clone(),
            byte_length: output.byte_length,
        }
    }

    pub(super) fn seal_test_observation(
        verifier: &mut BuildReceiptVerifier,
        challenge: &BuildTransactionChallenge,
        observation: TestBuildObservation,
    ) -> Result<ObservedBuildStepReceipt, BuildReceiptError> {
        let receipt = seal_unregistered_test_observation(challenge, observation)?;
        verifier.register_observed_receipt(challenge, &receipt)?;
        Ok(receipt)
    }

    pub(super) fn seal_unregistered_test_observation(
        challenge: &BuildTransactionChallenge,
        observation: TestBuildObservation,
    ) -> Result<ObservedBuildStepReceipt, BuildReceiptError> {
        if !observation.successful {
            return Err(BuildReceiptError::new("build_execution_did_not_succeed"));
        }
        if observation.executor_bytes.is_empty() || observation.outputs.is_empty() {
            return Err(BuildReceiptError::new(
                "build_execution_required_bytes_are_missing",
            ));
        }
        if observation.started_monotonic_ns < challenge.issued_monotonic_ns
            || observation.completed_monotonic_ns < observation.started_monotonic_ns
        {
            return Err(BuildReceiptError::new(
                "build_execution_monotonic_interval_is_invalid",
            ));
        }

        let mut input_ids = HashSet::with_capacity(observation.inputs.len());
        let mut inputs = Vec::with_capacity(observation.inputs.len());
        for input in &observation.inputs {
            if input.locator.is_empty() || input.locator.contains('\0') {
                return Err(BuildReceiptError::new("build_input_locator_is_invalid"));
            }
            validate_prefixed_hash(
                &input.input_id,
                RELOAD_ARTIFACT_INPUT_ID_PREFIX,
                "build_input_id_is_invalid",
            )?;
            if !input_ids.insert(input.input_id.as_str()) {
                return Err(BuildReceiptError::new(
                    "build_execution_contains_duplicate_input_id",
                ));
            }
            inputs.push(ObservedBuildInputReceipt {
                input_id: input.input_id.clone(),
                content_hash: content_hash(&input.bytes),
                byte_length: input.bytes.len() as u64,
                consumption_proof: OBSERVED_BUILD_INPUT_CONSUMPTION_PROOF.to_string(),
            });
        }
        inputs.sort_by(|left, right| left.input_id.cmp(&right.input_id));

        let mut output_ordinals = HashSet::with_capacity(observation.outputs.len());
        let mut outputs = Vec::with_capacity(observation.outputs.len());
        for output in &observation.outputs {
            if output.locator.is_empty() || output.locator.contains('\0') {
                return Err(BuildReceiptError::new("build_output_locator_is_invalid"));
            }
            if output.bytes.is_empty() || !output_ordinals.insert(output.output_ordinal) {
                return Err(BuildReceiptError::new(
                    "build_output_bytes_or_ordinal_is_invalid",
                ));
            }
            let mut direct = output.consumed_input_ids.clone();
            direct.sort();
            if direct.windows(2).any(|pair| pair[0] == pair[1])
                || direct
                    .iter()
                    .any(|input_id| !input_ids.contains(input_id.as_str()))
            {
                return Err(BuildReceiptError::new(
                    "build_output_direct_input_binding_is_invalid",
                ));
            }
            let mut upstream = output.consumed_upstream_outputs.clone();
            upstream.sort_by(|left, right| {
                left.producer_receipt_id
                    .cmp(&right.producer_receipt_id)
                    .then_with(|| left.output_ordinal.cmp(&right.output_ordinal))
            });
            outputs.push(ObservedBuildOutputReceipt {
                output_ordinal: output.output_ordinal,
                consumed_input_ids: direct,
                consumed_upstream_outputs: upstream,
                content_hash: content_hash(&output.bytes),
                byte_length: output.bytes.len() as u64,
            });
        }
        outputs.sort_by_key(|output| output.output_ordinal);

        let executor_hash = content_hash(&observation.executor_bytes);
        let invocation_hash = derive_test_invocation_hash(
            &executor_hash,
            &observation.invocation_components,
            &outputs,
        );
        let mut receipt = ObservedBuildStepReceipt {
            schema_version: OBSERVED_BUILD_STEP_RECEIPT_SCHEMA_VERSION.to_string(),
            evidence_authority: OBSERVED_BUILD_STEP_RECEIPT_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
            can_satisfy_build_transaction: true,
            input_transport_bound_to_execution_boundary: true,
            execution_policy_authorized: true,
            execution_runtime_closure_observed: true,
            observer_id: challenge.observer_id.clone(),
            clock_id: challenge.clock_id.clone(),
            challenge_id: challenge.challenge_id.clone(),
            challenge_expires_monotonic_ns: challenge.expires_monotonic_ns,
            receipt_id: String::new(),
            executor_hash,
            execution_boundary: "test_only_synthetic_build_observation_v1".to_string(),
            invocation_hash,
            started_monotonic_ns: observation.started_monotonic_ns,
            completed_monotonic_ns: observation.completed_monotonic_ns,
            inputs,
            outputs,
        };
        receipt.receipt_id = derive_step_receipt_id(&receipt);
        Ok(receipt)
    }

    fn derive_test_invocation_hash(
        executor_hash: &str,
        components: &[InvocationComponent],
        outputs: &[ObservedBuildOutputReceipt],
    ) -> String {
        let mut hasher = Sha256::new();
        hash_field(&mut hasher, b"synthi.test_build_invocation.v1");
        hash_field(&mut hasher, executor_hash.as_bytes());
        hasher.update((components.len() as u64).to_be_bytes());
        for component in components {
            match component {
                InvocationComponent::Literal(bytes) => {
                    hash_field(&mut hasher, b"literal");
                    hash_field(&mut hasher, bytes);
                }
                InvocationComponent::Input(input_id) => {
                    hash_field(&mut hasher, b"input");
                    hash_field(&mut hasher, input_id.as_bytes());
                }
                InvocationComponent::Upstream(reference) => {
                    hash_field(&mut hasher, b"upstream");
                    hash_field(&mut hasher, reference.producer_receipt_id.as_bytes());
                    hasher.update(reference.output_ordinal.to_be_bytes());
                    hash_field(&mut hasher, reference.content_hash.as_bytes());
                }
                InvocationComponent::Output(output_ordinal) => {
                    hash_field(&mut hasher, b"output");
                    hasher.update(output_ordinal.to_be_bytes());
                }
            }
        }
        hasher.update((outputs.len() as u64).to_be_bytes());
        for output in outputs {
            hasher.update(output.output_ordinal.to_be_bytes());
        }
        format!("sha256:{:x}", hasher.finalize())
    }

    pub(super) fn content_hash(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::hmr::build_manifest::{BuildArtifactIdentity, BuildDependencyIdentity, BuildSlot};
    use std::sync::Arc;

    const INPUT_A: &str =
        "artifact-input:sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const INPUT_B: &str =
        "artifact-input:sha256:2222222222222222222222222222222222222222222222222222222222222222";

    fn observation(
        challenge: &BuildTransactionChallenge,
        input_id: &str,
        input_bytes: &[u8],
        output_bytes: &[u8],
        upstream: Vec<ObservedBuildOutputReference>,
        start_offset: u64,
    ) -> TestBuildObservation {
        let mut components = vec![
            InvocationComponent::Literal(Arc::from(b"compile".as_slice())),
            InvocationComponent::Input(input_id.to_string()),
        ];
        components.extend(upstream.iter().cloned().map(InvocationComponent::Upstream));
        components.push(InvocationComponent::Output(0));
        TestBuildObservation {
            executor_bytes: Arc::from(b"executor-v1".as_slice()),
            invocation_components: components,
            started_monotonic_ns: challenge.issued_monotonic_ns + start_offset,
            completed_monotonic_ns: challenge.issued_monotonic_ns + start_offset + 1,
            successful: true,
            inputs: vec![InputBytes {
                input_id: input_id.to_string(),
                locator: "transport/input".into(),
                bytes: Arc::from(input_bytes),
            }],
            outputs: vec![OutputBytes {
                output_ordinal: 0,
                consumed_input_ids: vec![input_id.to_string()],
                consumed_upstream_outputs: upstream,
                locator: "transport/output".into(),
                bytes: Arc::from(output_bytes),
            }],
        }
    }

    fn artifact(
        receipt: &ObservedBuildStepReceipt,
        path: &str,
        input_id: &str,
        input_bytes: &[u8],
        output_bytes: &[u8],
        dependency_role_ids: Vec<String>,
        extra_dependencies: Vec<BuildDependencyIdentity>,
    ) -> BuildArtifactIdentity {
        let mut dependencies = vec![BuildDependencyIdentity::new(
            input_id,
            "transport/input",
            content_hash(input_bytes),
        )];
        dependencies.extend(extra_dependencies);
        BuildArtifactIdentity::new("ignored", path, content_hash(output_bytes))
            .with_byte_length(output_bytes.len() as u64)
            .with_reload_role_declaration(
                vec![input_id.to_string()],
                receipt.invocation_hash().to_string(),
                0,
                dependency_role_ids,
                dependencies,
            )
            .unwrap()
    }

    fn manifest(
        selected_path: &str,
        selected_hash: &str,
        artifacts: Vec<BuildArtifactIdentity>,
    ) -> BuildManifest {
        BuildManifest::new(
            "preview-metadata",
            "language-metadata",
            "adapter-metadata",
            0,
            BuildSlot::Full,
            selected_path,
            selected_hash,
        )
        .with_artifacts(artifacts)
    }

    #[test]
    fn challenge_ttl_is_bounded_and_terminal_expiry_is_single_use() {
        assert_eq!(
            BuildReceiptVerifier::with_challenge_ttl(Duration::ZERO)
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_ttl_is_invalid"
        );
        assert_eq!(
            BuildReceiptVerifier::with_challenge_ttl(
                MAX_BUILD_TRANSACTION_CHALLENGE_TTL + Duration::from_nanos(1),
            )
            .unwrap_err()
            .to_string(),
            "build_transaction_challenge_ttl_is_invalid"
        );
        assert_eq!(
            monotonic_duration_ns(Duration::new(u64::MAX, 999_999_999))
                .unwrap_err()
                .to_string(),
            "build_receipt_monotonic_clock_overflow"
        );

        let mut verifier =
            BuildReceiptVerifier::with_challenge_ttl(Duration::from_nanos(1)).unwrap();
        let challenge = verifier.begin_transaction().unwrap();
        assert!(challenge.expires_monotonic_ns > challenge.issued_monotonic_ns);
        while verifier.monotonic_now_ns().unwrap() < challenge.expires_monotonic_ns {
            std::thread::yield_now();
        }
        let uncommitted_manifest = BuildManifest::new(
            "preview-metadata",
            "language-metadata",
            "adapter-metadata",
            0,
            BuildSlot::Full,
            "out/a",
            &content_hash(b"out"),
        );

        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &uncommitted_manifest, &[])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_expired"
        );
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &uncommitted_manifest, &[])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
    }

    #[test]
    fn single_use_challenge_binds_build_bytes_without_runtime_authority() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let source = b"source-a";
        let output = b"artifact-a";
        let receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_A, source, output, Vec::new(), 1),
        )
        .unwrap();
        let artifact = artifact(
            &receipt,
            "out/a",
            INPUT_A,
            source,
            output,
            Vec::new(),
            Vec::new(),
        );
        let manifest = manifest("out/a", &content_hash(output), vec![artifact]);
        let verified = verifier
            .verify_reload_transaction(&challenge, &manifest, &[receipt.clone()])
            .unwrap();

        assert_eq!(receipt.evidence_authority(), OBSERVED_BUILD_STEP_RECEIPT_AUTHORITY);
        assert_eq!(
            verified.evidence_authority(),
            VERIFIED_RELOAD_BUILD_TRANSACTION_AUTHORITY
        );
        assert!(verified
            .receipt_id()
            .starts_with(VERIFIED_RELOAD_BUILD_TRANSACTION_ID_PREFIX));
        assert_eq!(verified.artifact_bindings().len(), 1);
        assert_eq!(
            verified.reload_transaction_commitment_id(),
            manifest.reload_transaction_commitment_identity().unwrap()
        );
        assert!(!verified.accepted_for_gpu_hmr);
        assert!(!verified.gpu_hmr_success);
        assert!(!verified.can_satisfy_runtime_proof);
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
    }

    #[test]
    fn challenge_and_receipts_cannot_cross_observer_instances() {
        let mut first = BuildReceiptVerifier::new();
        let challenge = first.begin_transaction().unwrap();
        let receipt = seal_test_observation(
            &mut first,
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out", Vec::new(), 1),
        )
        .unwrap();
        let artifact = artifact(
            &receipt,
            "out/a",
            INPUT_A,
            b"a",
            b"out",
            Vec::new(),
            Vec::new(),
        );
        let manifest = manifest("out/a", &content_hash(b"out"), vec![artifact]);
        let mut second = BuildReceiptVerifier::new();

        assert_eq!(
            second
                .verify_reload_transaction(&challenge, &manifest, &[receipt])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
    }

    #[test]
    fn self_consistent_but_unregistered_receipt_fails_closed() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let receipt = seal_unregistered_test_observation(
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out", Vec::new(), 1),
        )
        .unwrap();
        let artifact = artifact(
            &receipt,
            "out/a",
            INPUT_A,
            b"a",
            b"out",
            Vec::new(),
            Vec::new(),
        );
        let manifest = manifest("out/a", &content_hash(b"out"), vec![artifact]);

        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt.clone()])
                .unwrap_err()
                .to_string(),
            "build_transaction_receipt_registry_mismatch"
        );
        assert_eq!(
            verifier
                .register_observed_receipt(&challenge, &receipt)
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
    }

    #[test]
    fn sealed_receipt_rejects_noncanonical_duplicate_and_unobserved_bindings() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let base = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out", Vec::new(), 1),
        )
        .unwrap();

        let mut outputless = base.clone();
        outputless.outputs.clear();
        outputless.receipt_id = derive_step_receipt_id(&outputless);
        assert_eq!(
            validate_sealed_step_receipt(&outputless)
                .unwrap_err()
                .to_string(),
            "build_step_outputs_are_missing"
        );

        let mut duplicate_input = base.clone();
        duplicate_input.inputs.push(duplicate_input.inputs[0].clone());
        duplicate_input.receipt_id = derive_step_receipt_id(&duplicate_input);
        assert_eq!(
            validate_sealed_step_receipt(&duplicate_input)
                .unwrap_err()
                .to_string(),
            "build_step_contains_duplicate_input"
        );

        let mut duplicate_output = base.clone();
        duplicate_output.outputs.push(duplicate_output.outputs[0].clone());
        duplicate_output.receipt_id = derive_step_receipt_id(&duplicate_output);
        assert_eq!(
            validate_sealed_step_receipt(&duplicate_output)
                .unwrap_err()
                .to_string(),
            "build_step_contains_duplicate_output_ordinal"
        );

        let mut unobserved_input = base;
        unobserved_input.outputs[0].consumed_input_ids = vec![INPUT_B.to_string()];
        unobserved_input.receipt_id = derive_step_receipt_id(&unobserved_input);
        assert_eq!(
            validate_sealed_step_receipt(&unobserved_input)
                .unwrap_err()
                .to_string(),
            "build_step_output_input_is_unobserved"
        );

        let mut unbound_input = unobserved_input;
        unbound_input.outputs[0].consumed_input_ids = vec![INPUT_A.to_string()];
        unbound_input.inputs.push(ObservedBuildInputReceipt {
            input_id: INPUT_B.to_string(),
            content_hash: content_hash(b"b"),
            byte_length: 1,
            consumption_proof: OBSERVED_BUILD_INPUT_CONSUMPTION_PROOF.to_string(),
        });
        unbound_input.receipt_id = derive_step_receipt_id(&unbound_input);
        assert_eq!(
            validate_sealed_step_receipt(&unbound_input)
                .unwrap_err()
                .to_string(),
            "build_step_contains_input_unbound_to_output"
        );
    }

    #[test]
    fn multi_step_transaction_requires_observed_byte_and_temporal_edges() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let first_source = b"source-a";
        let first_output = b"artifact-a";
        let first_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(
                &challenge,
                INPUT_A,
                first_source,
                first_output,
                Vec::new(),
                1,
            ),
        )
        .unwrap();
        let first_artifact = artifact(
            &first_receipt,
            "out/a",
            INPUT_A,
            first_source,
            first_output,
            Vec::new(),
            Vec::new(),
        );
        let first_role_id = first_artifact.reload_role.as_ref().unwrap().role_id.clone();
        let edge = output_reference(&first_receipt, 0);
        let second_source = b"source-b";
        let second_output = b"artifact-b";
        let second_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(
                &challenge,
                INPUT_B,
                second_source,
                second_output,
                vec![edge],
                3,
            ),
        )
        .unwrap();
        let second_artifact = artifact(
            &second_receipt,
            "out/b",
            INPUT_B,
            second_source,
            second_output,
            vec![first_role_id],
            vec![BuildDependencyIdentity::new(
                INPUT_A,
                "transport/a",
                content_hash(first_source),
            )],
        );
        let manifest = manifest(
            "out/b",
            &content_hash(second_output),
            vec![first_artifact, second_artifact],
        );

        assert!(verifier
            .verify_reload_transaction(
                &challenge,
                &manifest,
                &[first_receipt, second_receipt]
            )
            .is_ok());
    }

    #[test]
    fn declared_dependency_without_observed_edge_fails_closed() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let first_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out-a", Vec::new(), 1),
        )
        .unwrap();
        let first_artifact = artifact(
            &first_receipt,
            "out/a",
            INPUT_A,
            b"a",
            b"out-a",
            Vec::new(),
            Vec::new(),
        );
        let first_role_id = first_artifact.reload_role.as_ref().unwrap().role_id.clone();
        let second_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_B, b"b", b"out-b", Vec::new(), 3),
        )
        .unwrap();
        let second_artifact = artifact(
            &second_receipt,
            "out/b",
            INPUT_B,
            b"b",
            b"out-b",
            vec![first_role_id],
            vec![BuildDependencyIdentity::new(
                INPUT_A,
                "transport/a",
                content_hash(b"a"),
            )],
        );
        let manifest = manifest(
            "out/b",
            &content_hash(b"out-b"),
            vec![first_artifact, second_artifact],
        );

        assert_eq!(
            verifier
                .verify_reload_transaction(
                    &challenge,
                    &manifest,
                    &[first_receipt, second_receipt]
                )
                .unwrap_err()
                .to_string(),
            "build_transaction_dependency_edge_count_mismatch"
        );
    }

    #[test]
    fn unrelated_receipt_cannot_satisfy_another_roles_source_closure() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let first_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out-a", Vec::new(), 1),
        )
        .unwrap();
        let second_receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_B, b"b", b"out-b", Vec::new(), 3),
        )
        .unwrap();
        let first_artifact = artifact(
            &first_receipt,
            "out/a",
            INPUT_A,
            b"a",
            b"out-a",
            Vec::new(),
            vec![BuildDependencyIdentity::new(
                INPUT_B,
                "transport/b",
                content_hash(b"b"),
            )],
        );
        let second_artifact = artifact(
            &second_receipt,
            "out/b",
            INPUT_B,
            b"b",
            b"out-b",
            Vec::new(),
            Vec::new(),
        );
        let manifest = manifest(
            "out/a",
            &content_hash(b"out-a"),
            vec![first_artifact, second_artifact],
        );

        assert_eq!(
            verifier
                .verify_reload_transaction(
                    &challenge,
                    &manifest,
                    &[first_receipt, second_receipt]
                )
                .unwrap_err()
                .to_string(),
            "build_transaction_role_input_reachability_mismatch"
        );
    }

    #[test]
    fn byte_mismatch_and_failed_test_observation_fail_closed() {
        let mut verifier = BuildReceiptVerifier::new();
        let challenge = verifier.begin_transaction().unwrap();
        let mut failed = observation(&challenge, INPUT_A, b"a", b"out-a", Vec::new(), 1);
        failed.successful = false;
        assert_eq!(
            seal_test_observation(&mut verifier, &challenge, failed)
                .unwrap_err()
                .to_string(),
            "build_execution_did_not_succeed"
        );

        let receipt = seal_test_observation(
            &mut verifier,
            &challenge,
            observation(&challenge, INPUT_A, b"a", b"out-a", Vec::new(), 1),
        )
        .unwrap();
        let mut artifact = artifact(
            &receipt,
            "out/a",
            INPUT_A,
            b"a",
            b"out-a",
            Vec::new(),
            Vec::new(),
        );
        artifact.artifact_hash = content_hash(b"forged");
        let manifest = manifest("out/a", &content_hash(b"forged"), vec![artifact]);
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt.clone()])
                .unwrap_err()
                .to_string(),
            "build_transaction_artifact_hash_mismatch"
        );
        assert_eq!(
            verifier
                .verify_reload_transaction(&challenge, &manifest, &[receipt])
                .unwrap_err()
                .to_string(),
            "build_transaction_challenge_is_not_active"
        );
    }
}
