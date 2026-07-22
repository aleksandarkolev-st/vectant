use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

pub const CLOSED_EXECUTION_PROVIDER_SCHEMA: &str =
    "synthi.closed_execution.provider_capability_manifest.v1";
pub const CLOSED_EXECUTION_PROVIDER_EVIDENCE_AUTHORITY: &str =
    "provider_mechanic_observation_only_not_closed_execution_or_gpu_hmr_acceptance";

#[cfg(test)]
const ID_DOMAIN: &[u8] = b"synthi.closed_execution.provider_identity.v1";
const REQUIREMENT_DOMAIN: &[u8] = b"synthi.closed_execution.provider_requirement.v1";
const REQUIREMENT_SET_DOMAIN: &[u8] = b"synthi.closed_execution.provider_requirement_set.v1";
const OBSERVATION_DOMAIN: &[u8] = b"synthi.closed_execution.provider_observation.v1";
const DESCRIPTOR_DOMAIN: &[u8] = b"synthi.closed_execution.provider_descriptor.v1";
const CHALLENGE_DOMAIN: &[u8] = b"synthi.closed_execution.provider_probe_challenge.v1";
const CHALLENGE_CONSUMPTION_DOMAIN: &[u8] =
    b"synthi.closed_execution.provider_challenge_consumption.v1";
const MANIFEST_DOMAIN: &[u8] = b"synthi.closed_execution.provider_manifest.v1";
const CREDENTIAL_SNAPSHOT_DOMAIN: &[u8] =
    b"synthi.closed_execution.provider_credential_snapshot.v1";
const EXECUTION_REQUEST_DOMAIN: &[u8] = b"synthi.closed_execution.provider_execution_request.v1";
const RECORD_CONTEXT_DOMAIN: &[u8] = b"synthi.closed_execution.provider_record_context.v1";
const RECORD_TRANSPORT_DOMAIN: &[u8] = b"synthi.closed_execution.provider_record_transport.v1";
const RECORD_BYTES_DOMAIN: &[u8] = b"synthi.closed_execution.provider_record_bytes.v1";
const SESSION_DOMAIN: &[u8] = b"synthi.closed_execution.provider_verified_session.v1";
const TRANSCRIPT_GENESIS_DOMAIN: &[u8] = b"synthi.closed_execution.provider_transcript_genesis.v1";
const PROCESS_SET_WITNESS_DOMAIN: &[u8] =
    b"synthi.closed_execution.provider_process_set_witness.v1";
const SPAWN_OBSERVATION_DOMAIN: &[u8] = b"synthi.closed_execution.provider_spawn_observation.v1";
const LIFECYCLE_OBSERVATION_DOMAIN: &[u8] =
    b"synthi.closed_execution.provider_lifecycle_observation.v1";
const MAX_VERSIONED_ID_BYTES: usize = 256;
const MAX_PARAMETER_KEY_BYTES: usize = 128;
const MAX_PARAMETER_VALUE_BYTES: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedExecutionProviderContractError {
    code: &'static str,
    detail: Option<String>,
}

impl ClosedExecutionProviderContractError {
    fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

impl fmt::Display for ClosedExecutionProviderContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ClosedExecutionProviderContractError {}

/// A canonical, content-addressed identity. It carries no platform, project,
/// backend, or architecture label and therefore cannot be used as a routing
/// shortcut.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ClosedExecutionContentIdentity(String);

impl ClosedExecutionContentIdentity {
    pub fn from_digest(digest: [u8; 32]) -> Result<Self, ClosedExecutionProviderContractError> {
        if digest == [0; 32] {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_content_identity_invalid",
            ));
        }
        Ok(Self(format!("sha256:{}", hex::encode(digest))))
    }

    pub fn hash_bytes(domain: &[u8], bytes: &[u8]) -> Self {
        hash_identity(domain, &[bytes])
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ClosedExecutionContentIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Verifier time is deliberately separate from provider observations. A
/// provider may report when native mechanics completed, but only this clock
/// decides whether the operation completed inside the caller's proof window.
trait ClosedExecutionMonotonicClock: fmt::Debug + Send + Sync {
    fn clock_identity(&self) -> &ClosedExecutionContentIdentity;
    fn verification_authority_identity(&self) -> &ClosedExecutionContentIdentity;
    fn now_monotonic_ns(&self) -> u64;
}

/// Evidence resolution is an independent trust boundary. Implementations must
/// resolve every reference and verify its content identity; provider-returned
/// hashes alone are never considered observed evidence.
trait ClosedExecutionEvidenceVerifier: fmt::Debug + Send + Sync {
    fn verifier_identity(&self) -> &ClosedExecutionContentIdentity;
    fn verification_authority_identity(&self) -> &ClosedExecutionContentIdentity;
    fn bound_clock_identity(&self) -> &ClosedExecutionContentIdentity;

    /// Atomically consumes a challenge in verifier-owned durable state. A
    /// failed session attempt still burns the challenge; replay must never be
    /// made possible by retrying provider mechanics.
    fn consume_challenge_once(
        &self,
        challenge: &ClosedExecutionProbeChallenge,
        session_deadline_monotonic_ns: u64,
    ) -> Result<ClosedExecutionContentIdentity, ClosedExecutionProviderContractError>;

    fn verify_evidence(
        &self,
        context_identity: &ClosedExecutionContentIdentity,
        evidence_refs: &[ClosedExecutionContentIdentity],
    ) -> Result<(), ClosedExecutionProviderContractError>;
}

/// Versioned identifiers are intentionally open vocabulary. The verifier
/// checks canonical shape and evidence, never membership in a central list.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ClosedExecutionMechanismId(String);

impl ClosedExecutionMechanismId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ClosedExecutionProviderContractError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_VERSIONED_ID_BYTES
            || !value.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(ClosedExecutionProviderContractError::with_detail(
                "closed_execution_mechanism_id_invalid",
                value,
            ));
        }
        let Some((namespace, version)) = value.rsplit_once(".v") else {
            return Err(ClosedExecutionProviderContractError::with_detail(
                "closed_execution_mechanism_id_unversioned",
                value,
            ));
        };
        if namespace.is_empty()
            || version.is_empty()
            || !version.bytes().all(|byte| byte.is_ascii_digit())
            || version
                .parse::<u64>()
                .ok()
                .filter(|value| *value > 0)
                .is_none()
        {
            return Err(ClosedExecutionProviderContractError::with_detail(
                "closed_execution_mechanism_id_unversioned",
                value,
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ClosedExecutionMechanismId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionRequirement {
    obligation_id: ClosedExecutionMechanismId,
    parameters: BTreeMap<String, String>,
    requirement_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionRequirement {
    pub fn new(
        obligation_id: ClosedExecutionMechanismId,
        parameters: BTreeMap<String, String>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        validate_parameters(&parameters)?;
        let requirement_identity = derive_requirement_identity(&obligation_id, &parameters);
        Ok(Self {
            obligation_id,
            parameters,
            requirement_identity,
        })
    }

    pub fn obligation_id(&self) -> &ClosedExecutionMechanismId {
        &self.obligation_id
    }

    pub fn parameters(&self) -> &BTreeMap<String, String> {
        &self.parameters
    }

    pub fn requirement_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.requirement_identity
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionRequirementSet {
    requirements: Vec<ClosedExecutionRequirement>,
    requirement_set_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionRequirementSet {
    pub fn new(
        mut requirements: Vec<ClosedExecutionRequirement>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if requirements.is_empty() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_requirement_set_empty",
            ));
        }
        requirements.sort_by(|left, right| {
            left.obligation_id
                .cmp(&right.obligation_id)
                .then_with(|| left.requirement_identity.cmp(&right.requirement_identity))
        });
        if requirements
            .windows(2)
            .any(|window| window[0].requirement_identity == window[1].requirement_identity)
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_requirement_duplicate",
            ));
        }
        let fields = requirements
            .iter()
            .map(|requirement| requirement.requirement_identity.as_str().as_bytes())
            .collect::<Vec<_>>();
        let requirement_set_identity = hash_identity(REQUIREMENT_SET_DOMAIN, &fields);
        Ok(Self {
            requirements,
            requirement_set_identity,
        })
    }

    pub fn requirements(&self) -> &[ClosedExecutionRequirement] {
        &self.requirements
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.requirement_set_identity
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedExecutionCapabilityOutcome {
    Observed,
    Unavailable,
    Blocked,
    PrerequisiteMissing,
    VersionInsufficient,
    ProbeFailed,
}

impl ClosedExecutionCapabilityOutcome {
    fn wire_value(self) -> u8 {
        match self {
            Self::Observed => 1,
            Self::Unavailable => 2,
            Self::Blocked => 3,
            Self::PrerequisiteMissing => 4,
            Self::VersionInsufficient => 5,
            Self::ProbeFailed => 6,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionCapabilityObservation {
    capability_id: ClosedExecutionMechanismId,
    outcome: ClosedExecutionCapabilityOutcome,
    satisfies_requirements: BTreeSet<ClosedExecutionContentIdentity>,
    evidence_refs: Vec<ClosedExecutionContentIdentity>,
    observation_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionCapabilityObservation {
    pub fn new(
        capability_id: ClosedExecutionMechanismId,
        outcome: ClosedExecutionCapabilityOutcome,
        satisfies_requirements: BTreeSet<ClosedExecutionContentIdentity>,
        mut evidence_refs: Vec<ClosedExecutionContentIdentity>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if evidence_refs.is_empty() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_capability_evidence_missing",
            ));
        }
        evidence_refs.sort();
        evidence_refs.dedup();
        let observation_identity = derive_observation_identity(
            &capability_id,
            outcome,
            &satisfies_requirements,
            &evidence_refs,
        );
        Ok(Self {
            capability_id,
            outcome,
            satisfies_requirements,
            evidence_refs,
            observation_identity,
        })
    }

    pub fn capability_id(&self) -> &ClosedExecutionMechanismId {
        &self.capability_id
    }

    pub fn outcome(&self) -> ClosedExecutionCapabilityOutcome {
        self.outcome
    }

    pub fn satisfies_requirements(&self) -> &BTreeSet<ClosedExecutionContentIdentity> {
        &self.satisfies_requirements
    }

    pub fn evidence_refs(&self) -> &[ClosedExecutionContentIdentity] {
        &self.evidence_refs
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.observation_identity
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionProviderDescriptor {
    provider_identity: ClosedExecutionContentIdentity,
    implementation_identity: ClosedExecutionContentIdentity,
    descriptor_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionProviderDescriptor {
    pub fn new(
        provider_identity: ClosedExecutionContentIdentity,
        implementation_identity: ClosedExecutionContentIdentity,
    ) -> Self {
        let descriptor_identity = hash_identity(
            DESCRIPTOR_DOMAIN,
            &[
                provider_identity.as_str().as_bytes(),
                implementation_identity.as_str().as_bytes(),
            ],
        );
        Self {
            provider_identity,
            implementation_identity,
            descriptor_identity,
        }
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn descriptor_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.descriptor_identity
    }

    pub fn implementation_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.implementation_identity
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionProbeChallenge {
    challenge_identity: ClosedExecutionContentIdentity,
    nonce_identity: ClosedExecutionContentIdentity,
    expires_monotonic_ns: u64,
}

impl ClosedExecutionProbeChallenge {
    pub fn new(
        nonce_identity: ClosedExecutionContentIdentity,
        expires_monotonic_ns: u64,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if expires_monotonic_ns == 0 {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_probe_challenge_deadline_invalid",
            ));
        }
        let challenge_identity = hash_identity(
            CHALLENGE_DOMAIN,
            &[
                nonce_identity.as_str().as_bytes(),
                &expires_monotonic_ns.to_be_bytes(),
            ],
        );
        Ok(Self {
            challenge_identity,
            nonce_identity,
            expires_monotonic_ns,
        })
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.challenge_identity
    }

    pub fn nonce_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.nonce_identity
    }

    pub fn expires_monotonic_ns(&self) -> u64 {
        self.expires_monotonic_ns
    }

    fn is_self_consistent(&self) -> bool {
        self.expires_monotonic_ns > 0
            && self.challenge_identity
                == hash_identity(
                    CHALLENGE_DOMAIN,
                    &[
                        self.nonce_identity.as_str().as_bytes(),
                        &self.expires_monotonic_ns.to_be_bytes(),
                    ],
                )
    }
}

/// A support-only capability result. Coverage means the provider supplied
/// evidence for every requested obligation; it never means that a process was
/// contained, an artifact was executed, or GPU HMR succeeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionProviderCapabilityManifest {
    schema_version: String,
    evidence_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_closed_execution: bool,
    can_satisfy_runtime_proof: bool,
    descriptor_identity: ClosedExecutionContentIdentity,
    provider_identity: ClosedExecutionContentIdentity,
    challenge_identity: ClosedExecutionContentIdentity,
    requirement_set_identity: ClosedExecutionContentIdentity,
    probe_started_monotonic_ns: u64,
    probe_completed_monotonic_ns: u64,
    observations: Vec<ClosedExecutionCapabilityObservation>,
    blocking_gaps: Vec<String>,
    manifest_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionProviderCapabilityManifest {
    pub fn new(
        descriptor: &ClosedExecutionProviderDescriptor,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
        probe_started_monotonic_ns: u64,
        probe_completed_monotonic_ns: u64,
        mut observations: Vec<ClosedExecutionCapabilityObservation>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if probe_started_monotonic_ns == 0
            || probe_started_monotonic_ns > probe_completed_monotonic_ns
            || probe_completed_monotonic_ns >= challenge.expires_monotonic_ns
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_probe_interval_invalid",
            ));
        }
        observations.sort_by(|left, right| left.capability_id.cmp(&right.capability_id));
        if observations
            .windows(2)
            .any(|window| window[0].capability_id == window[1].capability_id)
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_capability_duplicate",
            ));
        }
        let requested_requirement_ids = requirements
            .requirements
            .iter()
            .map(|requirement| &requirement.requirement_identity)
            .collect::<BTreeSet<_>>();
        if observations.iter().any(|observation| {
            observation
                .satisfies_requirements
                .iter()
                .any(|requirement_id| !requested_requirement_ids.contains(requirement_id))
        }) {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_unrequested_requirement_claimed",
            ));
        }
        let blocking_gaps = derive_blocking_gaps(requirements, &observations);
        let manifest_identity = derive_manifest_identity(
            descriptor,
            challenge,
            requirements,
            probe_started_monotonic_ns,
            probe_completed_monotonic_ns,
            &observations,
            &blocking_gaps,
        );
        let manifest = Self {
            schema_version: CLOSED_EXECUTION_PROVIDER_SCHEMA.to_string(),
            evidence_authority: CLOSED_EXECUTION_PROVIDER_EVIDENCE_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_closed_execution: false,
            can_satisfy_runtime_proof: false,
            descriptor_identity: descriptor.descriptor_identity.clone(),
            provider_identity: descriptor.provider_identity.clone(),
            challenge_identity: challenge.challenge_identity.clone(),
            requirement_set_identity: requirements.requirement_set_identity.clone(),
            probe_started_monotonic_ns,
            probe_completed_monotonic_ns,
            observations,
            blocking_gaps,
            manifest_identity,
        };
        if !manifest.is_self_consistent(descriptor, challenge, requirements) {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_manifest_integrity_failed",
            ));
        }
        Ok(manifest)
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn descriptor_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.descriptor_identity
    }

    pub fn challenge_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.challenge_identity
    }

    pub fn requirement_set_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.requirement_set_identity
    }

    pub fn observations(&self) -> &[ClosedExecutionCapabilityObservation] {
        &self.observations
    }

    pub fn blocking_gaps(&self) -> &[String] {
        &self.blocking_gaps
    }

    pub fn covers_requested_obligations(&self) -> bool {
        self.blocking_gaps.is_empty()
    }

    pub fn accepted_for_gpu_hmr(&self) -> bool {
        self.accepted_for_gpu_hmr
    }

    pub fn gpu_hmr_success(&self) -> bool {
        self.gpu_hmr_success
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.manifest_identity
    }

    pub fn validate_for(
        &self,
        descriptor: &ClosedExecutionProviderDescriptor,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if !self.is_self_consistent(descriptor, challenge, requirements) {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_manifest_binding_invalid",
            ));
        }
        Ok(())
    }

    pub fn validate_for_interval(
        &self,
        descriptor: &ClosedExecutionProviderDescriptor,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
        verifier_started_monotonic_ns: u64,
        verifier_completed_monotonic_ns: u64,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        self.validate_for(descriptor, challenge, requirements)?;
        if !challenge.is_self_consistent()
            || verifier_started_monotonic_ns == 0
            || verifier_started_monotonic_ns > verifier_completed_monotonic_ns
            || verifier_completed_monotonic_ns >= challenge.expires_monotonic_ns()
            || self.probe_started_monotonic_ns < verifier_started_monotonic_ns
            || self.probe_completed_monotonic_ns > verifier_completed_monotonic_ns
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_probe_verifier_interval_invalid",
            ));
        }
        Ok(())
    }

    fn is_self_consistent(
        &self,
        descriptor: &ClosedExecutionProviderDescriptor,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
    ) -> bool {
        self.schema_version == CLOSED_EXECUTION_PROVIDER_SCHEMA
            && self.evidence_authority == CLOSED_EXECUTION_PROVIDER_EVIDENCE_AUTHORITY
            && !self.accepted_for_gpu_hmr
            && !self.gpu_hmr_success
            && !self.can_satisfy_closed_execution
            && !self.can_satisfy_runtime_proof
            && self.descriptor_identity == descriptor.descriptor_identity
            && self.provider_identity == descriptor.provider_identity
            && self.challenge_identity == challenge.challenge_identity
            && self.requirement_set_identity == requirements.requirement_set_identity
            && self.probe_started_monotonic_ns > 0
            && self.probe_started_monotonic_ns <= self.probe_completed_monotonic_ns
            && self.probe_completed_monotonic_ns < challenge.expires_monotonic_ns
            && self.blocking_gaps == derive_blocking_gaps(requirements, &self.observations)
            && self.manifest_identity
                == derive_manifest_identity(
                    descriptor,
                    challenge,
                    requirements,
                    self.probe_started_monotonic_ns,
                    self.probe_completed_monotonic_ns,
                    &self.observations,
                    &self.blocking_gaps,
                )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionCredentialClaim {
    claim_id: ClosedExecutionMechanismId,
    value_identity: ClosedExecutionContentIdentity,
    evidence_ref: ClosedExecutionContentIdentity,
}

impl ClosedExecutionCredentialClaim {
    pub fn new(
        claim_id: ClosedExecutionMechanismId,
        value_identity: ClosedExecutionContentIdentity,
        evidence_ref: ClosedExecutionContentIdentity,
    ) -> Self {
        Self {
            claim_id,
            value_identity,
            evidence_ref,
        }
    }

    pub fn claim_id(&self) -> &ClosedExecutionMechanismId {
        &self.claim_id
    }

    pub fn value_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.value_identity
    }

    pub fn evidence_ref(&self) -> &ClosedExecutionContentIdentity {
        &self.evidence_ref
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionCredentialSnapshot {
    provider_identity: ClosedExecutionContentIdentity,
    peer_handle_identity: ClosedExecutionContentIdentity,
    challenge_identity: ClosedExecutionContentIdentity,
    observed_monotonic_ns: u64,
    claims: Vec<ClosedExecutionCredentialClaim>,
    snapshot_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionCredentialSnapshot {
    pub fn new(
        provider_identity: ClosedExecutionContentIdentity,
        peer_handle_identity: ClosedExecutionContentIdentity,
        challenge_identity: ClosedExecutionContentIdentity,
        observed_monotonic_ns: u64,
        mut claims: Vec<ClosedExecutionCredentialClaim>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if observed_monotonic_ns == 0 || claims.is_empty() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_credential_snapshot_invalid",
            ));
        }
        claims.sort_by(|left, right| left.claim_id.cmp(&right.claim_id));
        if claims
            .windows(2)
            .any(|window| window[0].claim_id == window[1].claim_id)
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_credential_claim_duplicate",
            ));
        }
        let snapshot_identity = derive_credential_snapshot_identity(
            &provider_identity,
            &peer_handle_identity,
            &challenge_identity,
            observed_monotonic_ns,
            &claims,
        );
        Ok(Self {
            provider_identity,
            peer_handle_identity,
            challenge_identity,
            observed_monotonic_ns,
            claims,
            snapshot_identity,
        })
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.snapshot_identity
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn peer_handle_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.peer_handle_identity
    }

    pub fn challenge_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.challenge_identity
    }

    pub fn observed_monotonic_ns(&self) -> u64 {
        self.observed_monotonic_ns
    }

    pub fn claims(&self) -> &[ClosedExecutionCredentialClaim] {
        &self.claims
    }

    pub fn validate_for(
        &self,
        provider_identity: &ClosedExecutionContentIdentity,
        peer_handle_identity: &ClosedExecutionContentIdentity,
        challenge: &ClosedExecutionProbeChallenge,
        verifier_started_monotonic_ns: u64,
        verifier_completed_monotonic_ns: u64,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if !challenge.is_self_consistent()
            || verifier_started_monotonic_ns == 0
            || verifier_started_monotonic_ns > verifier_completed_monotonic_ns
            || verifier_completed_monotonic_ns >= challenge.expires_monotonic_ns()
            || self.provider_identity != *provider_identity
            || self.peer_handle_identity != *peer_handle_identity
            || self.challenge_identity != *challenge.identity()
            || self.observed_monotonic_ns == 0
            || self.observed_monotonic_ns < verifier_started_monotonic_ns
            || self.observed_monotonic_ns > verifier_completed_monotonic_ns
            || self.observed_monotonic_ns >= challenge.expires_monotonic_ns()
            || self.claims.is_empty()
            || self.snapshot_identity
                != derive_credential_snapshot_identity(
                    &self.provider_identity,
                    &self.peer_handle_identity,
                    &self.challenge_identity,
                    self.observed_monotonic_ns,
                    &self.claims,
                )
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_credential_snapshot_binding_invalid",
            ));
        }
        Ok(())
    }
}

/// A verifier-created binding between one provider implementation, one fresh
/// challenge, one independently checked capability manifest, one authenticated
/// peer, and the exact canonical requirement set. It is intentionally not
/// cloneable: the ordered record transcript is part of the live session state.
#[derive(Debug)]
pub struct ClosedExecutionVerifiedSession {
    provider_identity: ClosedExecutionContentIdentity,
    descriptor_identity: ClosedExecutionContentIdentity,
    implementation_identity: ClosedExecutionContentIdentity,
    challenge_identity: ClosedExecutionContentIdentity,
    manifest_identity: ClosedExecutionContentIdentity,
    requirement_set: ClosedExecutionRequirementSet,
    credential_snapshot_identity: ClosedExecutionContentIdentity,
    verification_authority_identity: ClosedExecutionContentIdentity,
    verifier_clock_identity: ClosedExecutionContentIdentity,
    evidence_verifier_identity: ClosedExecutionContentIdentity,
    challenge_consumption_identity: ClosedExecutionContentIdentity,
    peer_handle_identity: ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
    session_identity: ClosedExecutionContentIdentity,
    next_record_sequence: u64,
    transcript_head_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionVerifiedSession {
    #[allow(clippy::too_many_arguments)]
    fn new(
        descriptor: &ClosedExecutionProviderDescriptor,
        challenge: &ClosedExecutionProbeChallenge,
        manifest: &ClosedExecutionProviderCapabilityManifest,
        requirement_set: ClosedExecutionRequirementSet,
        credential_snapshot: &ClosedExecutionCredentialSnapshot,
        verification_authority_identity: ClosedExecutionContentIdentity,
        verifier_clock_identity: ClosedExecutionContentIdentity,
        evidence_verifier_identity: ClosedExecutionContentIdentity,
        challenge_consumption_identity: ClosedExecutionContentIdentity,
        peer_handle_identity: ClosedExecutionContentIdentity,
        deadline_monotonic_ns: u64,
    ) -> Self {
        let session_identity = derive_session_identity(
            descriptor,
            challenge,
            manifest,
            &requirement_set,
            credential_snapshot,
            &verification_authority_identity,
            &verifier_clock_identity,
            &evidence_verifier_identity,
            &challenge_consumption_identity,
            &peer_handle_identity,
            deadline_monotonic_ns,
        );
        let transcript_head_identity = ClosedExecutionContentIdentity::hash_bytes(
            TRANSCRIPT_GENESIS_DOMAIN,
            session_identity.as_str().as_bytes(),
        );
        Self {
            provider_identity: descriptor.provider_identity().clone(),
            descriptor_identity: descriptor.descriptor_identity().clone(),
            implementation_identity: descriptor.implementation_identity().clone(),
            challenge_identity: challenge.identity().clone(),
            manifest_identity: manifest.identity().clone(),
            requirement_set,
            credential_snapshot_identity: credential_snapshot.identity().clone(),
            verification_authority_identity,
            verifier_clock_identity,
            evidence_verifier_identity,
            challenge_consumption_identity,
            peer_handle_identity,
            deadline_monotonic_ns,
            session_identity,
            next_record_sequence: 0,
            transcript_head_identity,
        }
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.session_identity
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn descriptor_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.descriptor_identity
    }

    pub fn implementation_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.implementation_identity
    }

    pub fn manifest_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.manifest_identity
    }

    pub fn requirements(&self) -> &ClosedExecutionRequirementSet {
        &self.requirement_set
    }

    pub fn peer_handle_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.peer_handle_identity
    }

    pub fn deadline_monotonic_ns(&self) -> u64 {
        self.deadline_monotonic_ns
    }

    fn record_context(
        &self,
        direction: ClosedExecutionRecordDirection,
    ) -> ClosedExecutionRecordContext {
        ClosedExecutionRecordContext::new(
            self.session_identity.clone(),
            self.next_record_sequence,
            self.transcript_head_identity.clone(),
            direction,
            self.deadline_monotonic_ns,
        )
    }

    fn advance_transcript(
        &mut self,
        observation_identity: ClosedExecutionContentIdentity,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        self.next_record_sequence = self.next_record_sequence.checked_add(1).ok_or_else(|| {
            ClosedExecutionProviderContractError::new("closed_execution_record_sequence_exhausted")
        })?;
        self.transcript_head_identity = observation_identity;
        Ok(())
    }

    fn is_self_consistent(&self, descriptor: &ClosedExecutionProviderDescriptor) -> bool {
        self.provider_identity == *descriptor.provider_identity()
            && self.descriptor_identity == *descriptor.descriptor_identity()
            && self.implementation_identity == *descriptor.implementation_identity()
            && self.deadline_monotonic_ns > 0
            && self.session_identity
                == derive_session_identity_from_fields(
                    &self.provider_identity,
                    &self.descriptor_identity,
                    &self.implementation_identity,
                    &self.challenge_identity,
                    &self.manifest_identity,
                    self.requirement_set.identity(),
                    &self.credential_snapshot_identity,
                    &self.verification_authority_identity,
                    &self.verifier_clock_identity,
                    &self.evidence_verifier_identity,
                    &self.challenge_consumption_identity,
                    &self.peer_handle_identity,
                    self.deadline_monotonic_ns,
                )
    }
}

/// Provider-neutral execution inputs. Providers translate these identities
/// into native handles; generic orchestration never needs an OS or architecture
/// discriminator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionRequest {
    session_identity: ClosedExecutionContentIdentity,
    provider_identity: ClosedExecutionContentIdentity,
    requirement_set_identity: ClosedExecutionContentIdentity,
    requirements: ClosedExecutionRequirementSet,
    invocation_identity: ClosedExecutionContentIdentity,
    executable_identity: ClosedExecutionContentIdentity,
    execution_closure_identity: ClosedExecutionContentIdentity,
    execution_policy_identity: ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
    parameters: BTreeMap<String, String>,
    request_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionRequest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session: &ClosedExecutionVerifiedSession,
        invocation_identity: ClosedExecutionContentIdentity,
        executable_identity: ClosedExecutionContentIdentity,
        execution_closure_identity: ClosedExecutionContentIdentity,
        execution_policy_identity: ClosedExecutionContentIdentity,
        deadline_monotonic_ns: u64,
        parameters: BTreeMap<String, String>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if deadline_monotonic_ns == 0 || deadline_monotonic_ns > session.deadline_monotonic_ns {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_request_deadline_invalid",
            ));
        }
        validate_parameters(&parameters)?;
        let session_identity = session.session_identity.clone();
        let provider_identity = session.provider_identity.clone();
        let requirements = session.requirement_set.clone();
        let requirement_set_identity = requirements.identity().clone();
        let request_identity = derive_execution_request_identity(
            &session_identity,
            &provider_identity,
            &requirement_set_identity,
            &invocation_identity,
            &executable_identity,
            &execution_closure_identity,
            &execution_policy_identity,
            deadline_monotonic_ns,
            &parameters,
        );
        Ok(Self {
            session_identity,
            provider_identity,
            requirement_set_identity,
            requirements,
            invocation_identity,
            executable_identity,
            execution_closure_identity,
            execution_policy_identity,
            deadline_monotonic_ns,
            parameters,
            request_identity,
        })
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn session_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.session_identity
    }

    pub fn requirement_set_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.requirement_set_identity
    }

    pub fn requirements(&self) -> &ClosedExecutionRequirementSet {
        &self.requirements
    }

    pub fn invocation_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.invocation_identity
    }

    pub fn executable_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.executable_identity
    }

    pub fn execution_closure_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.execution_closure_identity
    }

    pub fn execution_policy_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.execution_policy_identity
    }

    pub fn deadline_monotonic_ns(&self) -> u64 {
        self.deadline_monotonic_ns
    }

    pub fn parameters(&self) -> &BTreeMap<String, String> {
        &self.parameters
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.request_identity
    }

    fn is_self_consistent(&self) -> bool {
        self.deadline_monotonic_ns > 0
            && self.requirement_set_identity == *self.requirements.identity()
            && validate_parameters(&self.parameters).is_ok()
            && self.request_identity
                == derive_execution_request_identity(
                    &self.session_identity,
                    &self.provider_identity,
                    &self.requirement_set_identity,
                    &self.invocation_identity,
                    &self.executable_identity,
                    &self.execution_closure_identity,
                    &self.execution_policy_identity,
                    self.deadline_monotonic_ns,
                    &self.parameters,
                )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedExecutionRecordDirection {
    Sent,
    Received,
}

impl ClosedExecutionRecordDirection {
    fn wire_value(self) -> u8 {
        match self {
            Self::Sent => 1,
            Self::Received => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionRecordContext {
    session_identity: ClosedExecutionContentIdentity,
    sequence: u64,
    predecessor_identity: ClosedExecutionContentIdentity,
    direction: ClosedExecutionRecordDirection,
    deadline_monotonic_ns: u64,
    context_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionRecordContext {
    fn new(
        session_identity: ClosedExecutionContentIdentity,
        sequence: u64,
        predecessor_identity: ClosedExecutionContentIdentity,
        direction: ClosedExecutionRecordDirection,
        deadline_monotonic_ns: u64,
    ) -> Self {
        let context_identity = derive_record_context_identity(
            &session_identity,
            sequence,
            &predecessor_identity,
            direction,
            deadline_monotonic_ns,
        );
        Self {
            session_identity,
            sequence,
            predecessor_identity,
            direction,
            deadline_monotonic_ns,
            context_identity,
        }
    }

    pub fn session_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.session_identity
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn predecessor_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.predecessor_identity
    }

    pub fn direction(&self) -> ClosedExecutionRecordDirection {
        self.direction
    }

    pub fn deadline_monotonic_ns(&self) -> u64 {
        self.deadline_monotonic_ns
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.context_identity
    }

    fn is_self_consistent(&self) -> bool {
        self.deadline_monotonic_ns > 0
            && self.context_identity
                == derive_record_context_identity(
                    &self.session_identity,
                    self.sequence,
                    &self.predecessor_identity,
                    self.direction,
                    self.deadline_monotonic_ns,
                )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedExecutionRecordTransportObservation {
    provider_identity: ClosedExecutionContentIdentity,
    peer_handle_identity: ClosedExecutionContentIdentity,
    context_identity: ClosedExecutionContentIdentity,
    session_identity: ClosedExecutionContentIdentity,
    sequence: u64,
    predecessor_identity: ClosedExecutionContentIdentity,
    record_identity: ClosedExecutionContentIdentity,
    direction: ClosedExecutionRecordDirection,
    completed_monotonic_ns: u64,
    evidence_refs: Vec<ClosedExecutionContentIdentity>,
    observation_identity: ClosedExecutionContentIdentity,
}

impl ClosedExecutionRecordTransportObservation {
    pub fn new(
        provider_identity: ClosedExecutionContentIdentity,
        peer_handle_identity: ClosedExecutionContentIdentity,
        context: &ClosedExecutionRecordContext,
        record: &[u8],
        completed_monotonic_ns: u64,
        mut evidence_refs: Vec<ClosedExecutionContentIdentity>,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        if !context.is_self_consistent()
            || record.is_empty()
            || completed_monotonic_ns == 0
            || evidence_refs.is_empty()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_record_transport_observation_invalid",
            ));
        }
        evidence_refs.sort();
        evidence_refs.dedup();
        let record_identity =
            ClosedExecutionContentIdentity::hash_bytes(RECORD_BYTES_DOMAIN, record);
        let observation_identity = derive_record_transport_identity(
            &provider_identity,
            &peer_handle_identity,
            context,
            &record_identity,
            completed_monotonic_ns,
            &evidence_refs,
        );
        Ok(Self {
            provider_identity,
            peer_handle_identity,
            context_identity: context.identity().clone(),
            session_identity: context.session_identity().clone(),
            sequence: context.sequence(),
            predecessor_identity: context.predecessor_identity().clone(),
            record_identity,
            direction: context.direction(),
            completed_monotonic_ns,
            evidence_refs,
            observation_identity,
        })
    }

    pub fn completed_monotonic_ns(&self) -> u64 {
        self.completed_monotonic_ns
    }

    pub fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.provider_identity
    }

    pub fn peer_handle_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.peer_handle_identity
    }

    pub fn record_identity(&self) -> &ClosedExecutionContentIdentity {
        &self.record_identity
    }

    pub fn direction(&self) -> ClosedExecutionRecordDirection {
        self.direction
    }

    pub fn evidence_refs(&self) -> &[ClosedExecutionContentIdentity] {
        &self.evidence_refs
    }

    pub fn identity(&self) -> &ClosedExecutionContentIdentity {
        &self.observation_identity
    }

    pub fn validate_for(
        &self,
        provider_identity: &ClosedExecutionContentIdentity,
        peer_handle_identity: &ClosedExecutionContentIdentity,
        context: &ClosedExecutionRecordContext,
        record: &[u8],
        verifier_started_monotonic_ns: u64,
        verifier_completed_monotonic_ns: u64,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        let record_identity =
            ClosedExecutionContentIdentity::hash_bytes(RECORD_BYTES_DOMAIN, record);
        if record.is_empty()
            || !context.is_self_consistent()
            || verifier_started_monotonic_ns == 0
            || verifier_started_monotonic_ns > verifier_completed_monotonic_ns
            || verifier_completed_monotonic_ns >= context.deadline_monotonic_ns()
            || self.provider_identity != *provider_identity
            || self.peer_handle_identity != *peer_handle_identity
            || self.context_identity != *context.identity()
            || self.session_identity != *context.session_identity()
            || self.sequence != context.sequence()
            || self.predecessor_identity != *context.predecessor_identity()
            || self.record_identity != record_identity
            || self.direction != context.direction()
            || self.completed_monotonic_ns == 0
            || self.completed_monotonic_ns < verifier_started_monotonic_ns
            || self.completed_monotonic_ns > verifier_completed_monotonic_ns
            || self.evidence_refs.is_empty()
            || self.observation_identity
                != derive_record_transport_identity(
                    &self.provider_identity,
                    &self.peer_handle_identity,
                    context,
                    &self.record_identity,
                    self.completed_monotonic_ns,
                    &self.evidence_refs,
                )
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_record_transport_binding_invalid",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum ClosedExecutionProviderInvocationError<E> {
    Provider(E),
    Contract(ClosedExecutionProviderContractError),
}

impl<E: fmt::Display> fmt::Display for ClosedExecutionProviderInvocationError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Provider(error) => write!(formatter, "closed_execution_provider_failed:{error}"),
            Self::Contract(error) => error.fmt(formatter),
        }
    }
}

impl<E: Error + 'static> Error for ClosedExecutionProviderInvocationError<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Provider(error) => Some(error),
            Self::Contract(error) => Some(error),
        }
    }
}

impl<E> From<ClosedExecutionProviderContractError> for ClosedExecutionProviderInvocationError<E> {
    fn from(error: ClosedExecutionProviderContractError) -> Self {
        Self::Contract(error)
    }
}

trait ClosedExecutionProviderHandle: fmt::Debug + Send + Sync {
    fn provider_identity(&self) -> &ClosedExecutionContentIdentity;
    fn handle_identity(&self) -> &ClosedExecutionContentIdentity;
}

trait ClosedExecutionProcessSetHandle: ClosedExecutionProviderHandle {
    fn session_identity(&self) -> &ClosedExecutionContentIdentity;
    fn request_identity(&self) -> &ClosedExecutionContentIdentity;
    fn deadline_monotonic_ns(&self) -> u64;
    fn containment_witness_identity(&self) -> &ClosedExecutionContentIdentity;
    fn containment_evidence_refs(&self) -> &[ClosedExecutionContentIdentity];
}

trait ClosedExecutionPeerBinding: ClosedExecutionProviderHandle {
    type Error: Error + Send + Sync + 'static;

    fn credential_snapshot(
        &self,
        challenge: &ClosedExecutionProbeChallenge,
    ) -> Result<ClosedExecutionCredentialSnapshot, Self::Error>;
    fn ensure_live(&self) -> Result<(), Self::Error>;
    fn send_record(
        &self,
        context: &ClosedExecutionRecordContext,
        record: &[u8],
    ) -> Result<ClosedExecutionRecordTransportObservation, Self::Error>;
    fn receive_record(
        &self,
        context: &ClosedExecutionRecordContext,
    ) -> Result<(Vec<u8>, ClosedExecutionRecordTransportObservation), Self::Error>;
}

trait ClosedExecutionSpawnPlan: fmt::Debug + Send + Sync {
    fn provider_identity(&self) -> &ClosedExecutionContentIdentity;
    fn plan_identity(&self) -> &ClosedExecutionContentIdentity;
    fn session_identity(&self) -> &ClosedExecutionContentIdentity;
    fn requirement_set_identity(&self) -> &ClosedExecutionContentIdentity;
    fn request_identity(&self) -> &ClosedExecutionContentIdentity;
    fn deadline_monotonic_ns(&self) -> u64;
}

trait ClosedExecutionProcessHandle: ClosedExecutionProviderHandle {
    fn session_identity(&self) -> &ClosedExecutionContentIdentity;
    fn spawned_monotonic_ns(&self) -> u64;
    fn spawn_observation_identity(&self) -> &ClosedExecutionContentIdentity;
    fn spawn_evidence_refs(&self) -> &[ClosedExecutionContentIdentity];
    fn request_identity(&self) -> &ClosedExecutionContentIdentity;
    fn spawn_plan_identity(&self) -> &ClosedExecutionContentIdentity;
    fn process_set_identity(&self) -> &ClosedExecutionContentIdentity;
    fn deadline_monotonic_ns(&self) -> u64;
}

trait ClosedExecutionLifecycleObservation: fmt::Debug + Send + Sync {
    fn provider_identity(&self) -> &ClosedExecutionContentIdentity;
    fn subject_identity(&self) -> &ClosedExecutionContentIdentity;
    fn observation_identity(&self) -> &ClosedExecutionContentIdentity;
    fn observed_monotonic_ns(&self) -> u64;
    fn evidence_refs(&self) -> &[ClosedExecutionContentIdentity];
}

/// Providers implement mechanics, while the verifier owns obligations and
/// acceptance. Associated endpoint/handle types keep OS-specific descriptors
/// out of this contract and avoid a closed architecture enum.
trait ClosedExecutionProvider: fmt::Debug + Send + Sync {
    type Error: Error + Send + Sync + 'static;
    type PeerEndpoint;
    type PeerBinding: ClosedExecutionPeerBinding<Error = Self::Error>;
    type SpawnPlan: ClosedExecutionSpawnPlan;
    type ProcessSet: ClosedExecutionProcessSetHandle;
    type Process: ClosedExecutionProcessHandle;
    type TerminationObservation: ClosedExecutionLifecycleObservation;
    type ExitObservation: ClosedExecutionLifecycleObservation;

    fn descriptor(&self) -> &ClosedExecutionProviderDescriptor;
    fn probe(
        &self,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
    ) -> Result<ClosedExecutionProviderCapabilityManifest, Self::Error>;
    fn observe_peer(&self, endpoint: Self::PeerEndpoint) -> Result<Self::PeerBinding, Self::Error>;
    fn create_process_set(
        &self,
        request: &ClosedExecutionRequest,
    ) -> Result<Self::ProcessSet, Self::Error>;
    fn prepare_spawn(
        &self,
        request: &ClosedExecutionRequest,
        process_set: &Self::ProcessSet,
    ) -> Result<Self::SpawnPlan, Self::Error>;
    fn spawn(
        &self,
        plan: &Self::SpawnPlan,
        process_set: &Self::ProcessSet,
    ) -> Result<Self::Process, Self::Error>;
    fn terminate(
        &self,
        process_set: &Self::ProcessSet,
        deadline_monotonic_ns: u64,
    ) -> Result<Self::TerminationObservation, Self::Error>;
    fn observe_exit(
        &self,
        process: &Self::Process,
        deadline_monotonic_ns: u64,
    ) -> Result<Self::ExitObservation, Self::Error>;
}

/// Shared verification around provider operations. Native providers supply
/// mechanics and evidence but cannot redefine challenge, handle, request, or
/// deadline binding.
#[derive(Debug)]
struct VerifiedClosedExecutionProvider<
    'a,
    P: ClosedExecutionProvider,
    C: ClosedExecutionMonotonicClock,
    V: ClosedExecutionEvidenceVerifier,
> {
    provider: &'a P,
    clock: &'a C,
    evidence_verifier: &'a V,
}

impl<
        'a,
        P: ClosedExecutionProvider,
        C: ClosedExecutionMonotonicClock,
        V: ClosedExecutionEvidenceVerifier,
    > VerifiedClosedExecutionProvider<'a, P, C, V>
{
    fn try_new(
        provider: &'a P,
        clock: &'a C,
        evidence_verifier: &'a V,
    ) -> Result<Self, ClosedExecutionProviderContractError> {
        let descriptor = provider.descriptor();
        let authority_identity = clock.verification_authority_identity();
        let role_identities = [
            descriptor.provider_identity(),
            descriptor.descriptor_identity(),
            descriptor.implementation_identity(),
            clock.clock_identity(),
            evidence_verifier.verifier_identity(),
            authority_identity,
        ];
        let unique_role_count = role_identities
            .iter()
            .map(|identity| identity.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        let provider_address = (provider as *const P).cast::<()>();
        let clock_address = (clock as *const C).cast::<()>();
        let verifier_address = (evidence_verifier as *const V).cast::<()>();
        if unique_role_count != role_identities.len()
            || authority_identity != evidence_verifier.verification_authority_identity()
            || clock.clock_identity() != evidence_verifier.bound_clock_identity()
            || provider_address == clock_address
            || provider_address == verifier_address
            || clock_address == verifier_address
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_verification_roles_not_independent",
            ));
        }
        Ok(Self {
            provider,
            clock,
            evidence_verifier,
        })
    }

    pub fn descriptor(&self) -> &ClosedExecutionProviderDescriptor {
        self.provider.descriptor()
    }

    pub fn probe(
        &self,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
    ) -> Result<
        ClosedExecutionProviderCapabilityManifest,
        ClosedExecutionProviderInvocationError<P::Error>,
    > {
        let started = self.begin_operation(challenge.expires_monotonic_ns())?;
        let manifest = self
            .provider
            .probe(challenge, requirements)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, challenge.expires_monotonic_ns())?;
        manifest.validate_for_interval(
            self.provider.descriptor(),
            challenge,
            requirements,
            started,
            completed,
        )?;
        let evidence_refs = manifest
            .observations()
            .iter()
            .flat_map(|observation| observation.evidence_refs().iter().cloned())
            .collect::<Vec<_>>();
        if !evidence_refs.is_empty() {
            self.verify_evidence(
                manifest.identity(),
                &evidence_refs,
                challenge.expires_monotonic_ns(),
            )?;
        }
        Ok(manifest)
    }

    pub fn observe_peer(
        &self,
        endpoint: P::PeerEndpoint,
    ) -> Result<P::PeerBinding, ClosedExecutionProviderInvocationError<P::Error>> {
        let binding = self
            .provider
            .observe_peer(endpoint)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        self.validate_handle(&binding)?;
        Ok(binding)
    }

    pub fn credential_snapshot(
        &self,
        binding: &P::PeerBinding,
        challenge: &ClosedExecutionProbeChallenge,
    ) -> Result<ClosedExecutionCredentialSnapshot, ClosedExecutionProviderInvocationError<P::Error>>
    {
        self.validate_handle(binding)?;
        let started = self.begin_operation(challenge.expires_monotonic_ns())?;
        binding
            .ensure_live()
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let snapshot = binding
            .credential_snapshot(challenge)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, challenge.expires_monotonic_ns())?;
        snapshot.validate_for(
            self.provider.descriptor().provider_identity(),
            binding.handle_identity(),
            challenge,
            started,
            completed,
        )?;
        let evidence_refs = snapshot
            .claims()
            .iter()
            .map(|claim| claim.evidence_ref().clone())
            .collect::<Vec<_>>();
        self.verify_evidence(
            snapshot.identity(),
            &evidence_refs,
            challenge.expires_monotonic_ns(),
        )?;
        Ok(snapshot)
    }

    pub fn establish_session(
        &self,
        endpoint: P::PeerEndpoint,
        challenge: &ClosedExecutionProbeChallenge,
        requirements: &ClosedExecutionRequirementSet,
        deadline_monotonic_ns: u64,
    ) -> Result<
        (
            P::PeerBinding,
            ClosedExecutionProviderCapabilityManifest,
            ClosedExecutionCredentialSnapshot,
            ClosedExecutionVerifiedSession,
        ),
        ClosedExecutionProviderInvocationError<P::Error>,
    > {
        if deadline_monotonic_ns == 0 || deadline_monotonic_ns > challenge.expires_monotonic_ns() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_session_deadline_invalid",
            )
            .into());
        }
        let challenge_consumption_identity =
            self.consume_challenge_once(challenge, deadline_monotonic_ns)?;
        let manifest = self.probe(challenge, requirements)?;
        if !manifest.covers_requested_obligations() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_session_requirements_unobserved",
            )
            .into());
        }
        let binding = self.observe_peer(endpoint)?;
        let snapshot = self.credential_snapshot(&binding, challenge)?;
        self.begin_operation(deadline_monotonic_ns)?;
        let session = ClosedExecutionVerifiedSession::new(
            self.provider.descriptor(),
            challenge,
            &manifest,
            requirements.clone(),
            &snapshot,
            self.clock.verification_authority_identity().clone(),
            self.clock.clock_identity().clone(),
            self.evidence_verifier.verifier_identity().clone(),
            challenge_consumption_identity,
            binding.handle_identity().clone(),
            deadline_monotonic_ns,
        );
        Ok((binding, manifest, snapshot, session))
    }

    pub fn send_record(
        &self,
        session: &mut ClosedExecutionVerifiedSession,
        binding: &P::PeerBinding,
        record: &[u8],
    ) -> Result<
        ClosedExecutionRecordTransportObservation,
        ClosedExecutionProviderInvocationError<P::Error>,
    > {
        self.validate_session(session)?;
        self.validate_session_peer(session, binding)?;
        let context = session.record_context(ClosedExecutionRecordDirection::Sent);
        let started = self.begin_operation(session.deadline_monotonic_ns())?;
        binding
            .ensure_live()
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let observation = binding
            .send_record(&context, record)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, session.deadline_monotonic_ns())?;
        observation.validate_for(
            self.provider.descriptor().provider_identity(),
            binding.handle_identity(),
            &context,
            record,
            started,
            completed,
        )?;
        self.verify_evidence(
            observation.identity(),
            observation.evidence_refs(),
            session.deadline_monotonic_ns(),
        )?;
        session.advance_transcript(observation.identity().clone())?;
        Ok(observation)
    }

    pub fn receive_record(
        &self,
        session: &mut ClosedExecutionVerifiedSession,
        binding: &P::PeerBinding,
    ) -> Result<
        (Vec<u8>, ClosedExecutionRecordTransportObservation),
        ClosedExecutionProviderInvocationError<P::Error>,
    > {
        self.validate_session(session)?;
        self.validate_session_peer(session, binding)?;
        let context = session.record_context(ClosedExecutionRecordDirection::Received);
        let started = self.begin_operation(session.deadline_monotonic_ns())?;
        binding
            .ensure_live()
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let (record, observation) = binding
            .receive_record(&context)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, session.deadline_monotonic_ns())?;
        observation.validate_for(
            self.provider.descriptor().provider_identity(),
            binding.handle_identity(),
            &context,
            &record,
            started,
            completed,
        )?;
        self.verify_evidence(
            observation.identity(),
            observation.evidence_refs(),
            session.deadline_monotonic_ns(),
        )?;
        session.advance_transcript(observation.identity().clone())?;
        Ok((record, observation))
    }

    pub fn create_process_set(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
    ) -> Result<P::ProcessSet, ClosedExecutionProviderInvocationError<P::Error>> {
        self.validate_request(session, request)?;
        let started = self.begin_operation(request.deadline_monotonic_ns())?;
        let process_set = self
            .provider
            .create_process_set(request)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        self.complete_operation(started, request.deadline_monotonic_ns())?;
        self.validate_handle(&process_set)?;
        if process_set.session_identity() != session.identity()
            || process_set.request_identity() != request.identity()
            || process_set.deadline_monotonic_ns() != request.deadline_monotonic_ns()
            || process_set.containment_evidence_refs().is_empty()
            || process_set.containment_witness_identity()
                != &derive_process_set_witness_identity(
                    self.provider.descriptor().provider_identity(),
                    process_set.handle_identity(),
                    session.identity(),
                    request.identity(),
                    process_set.deadline_monotonic_ns(),
                    process_set.containment_evidence_refs(),
                )
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_process_set_binding_invalid",
            )
            .into());
        }
        self.verify_evidence(
            process_set.containment_witness_identity(),
            process_set.containment_evidence_refs(),
            request.deadline_monotonic_ns(),
        )?;
        Ok(process_set)
    }

    pub fn prepare_spawn(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
        process_set: &P::ProcessSet,
    ) -> Result<P::SpawnPlan, ClosedExecutionProviderInvocationError<P::Error>> {
        self.validate_request(session, request)?;
        self.validate_process_set(session, request, process_set)?;
        let started = self.begin_operation(request.deadline_monotonic_ns())?;
        let plan = self
            .provider
            .prepare_spawn(request, process_set)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        self.complete_operation(started, request.deadline_monotonic_ns())?;
        self.validate_plan(session, request, &plan)?;
        Ok(plan)
    }

    pub fn spawn(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
        plan: &P::SpawnPlan,
        process_set: &P::ProcessSet,
    ) -> Result<P::Process, ClosedExecutionProviderInvocationError<P::Error>> {
        self.validate_request(session, request)?;
        self.validate_process_set(session, request, process_set)?;
        self.validate_plan(session, request, plan)?;
        let started = self.begin_operation(request.deadline_monotonic_ns())?;
        let process = self
            .provider
            .spawn(plan, process_set)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, request.deadline_monotonic_ns())?;
        self.validate_handle(&process)?;
        if process.session_identity() != session.identity()
            || process.request_identity() != request.identity()
            || process.spawn_plan_identity() != plan.plan_identity()
            || process.process_set_identity() != process_set.handle_identity()
            || process.deadline_monotonic_ns() != request.deadline_monotonic_ns()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_spawn_binding_invalid",
            )
            .into());
        }
        if process.spawned_monotonic_ns() < started || process.spawned_monotonic_ns() > completed {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_spawn_verifier_interval_invalid",
            )
            .into());
        }
        if process.spawn_evidence_refs().is_empty()
            || process.spawn_observation_identity()
                != &derive_spawn_observation_identity(
                    self.provider.descriptor().provider_identity(),
                    process.handle_identity(),
                    session.identity(),
                    request.identity(),
                    plan.plan_identity(),
                    process_set.handle_identity(),
                    process.spawned_monotonic_ns(),
                    process.spawn_evidence_refs(),
                )
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_spawn_observation_binding_invalid",
            )
            .into());
        }
        self.verify_evidence(
            process.spawn_observation_identity(),
            process.spawn_evidence_refs(),
            request.deadline_monotonic_ns(),
        )?;
        Ok(process)
    }

    pub fn terminate(
        &self,
        session: &ClosedExecutionVerifiedSession,
        process_set: &P::ProcessSet,
    ) -> Result<P::TerminationObservation, ClosedExecutionProviderInvocationError<P::Error>> {
        self.validate_session(session)?;
        self.validate_handle(process_set)?;
        if process_set.session_identity() != session.identity() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_process_set_session_binding_invalid",
            )
            .into());
        }
        let deadline_monotonic_ns = process_set.deadline_monotonic_ns();
        let started = self.begin_operation(deadline_monotonic_ns)?;
        let observation = self
            .provider
            .terminate(process_set, deadline_monotonic_ns)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, deadline_monotonic_ns)?;
        self.validate_lifecycle_observation(&observation, process_set, started, completed)?;
        self.verify_evidence(
            observation.observation_identity(),
            observation.evidence_refs(),
            deadline_monotonic_ns,
        )?;
        Ok(observation)
    }

    pub fn observe_exit(
        &self,
        session: &ClosedExecutionVerifiedSession,
        process: &P::Process,
    ) -> Result<P::ExitObservation, ClosedExecutionProviderInvocationError<P::Error>> {
        self.validate_session(session)?;
        self.validate_handle(process)?;
        if process.session_identity() != session.identity() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_process_session_binding_invalid",
            )
            .into());
        }
        let deadline_monotonic_ns = process.deadline_monotonic_ns();
        let started = self.begin_operation(deadline_monotonic_ns)?;
        let observation = self
            .provider
            .observe_exit(process, deadline_monotonic_ns)
            .map_err(ClosedExecutionProviderInvocationError::Provider)?;
        let completed = self.complete_operation(started, deadline_monotonic_ns)?;
        self.validate_lifecycle_observation(&observation, process, started, completed)?;
        self.verify_evidence(
            observation.observation_identity(),
            observation.evidence_refs(),
            deadline_monotonic_ns,
        )?;
        Ok(observation)
    }

    fn validate_session(
        &self,
        session: &ClosedExecutionVerifiedSession,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if !session.is_self_consistent(self.provider.descriptor())
            || session.verification_authority_identity
                != *self.clock.verification_authority_identity()
            || session.verifier_clock_identity != *self.clock.clock_identity()
            || session.evidence_verifier_identity != *self.evidence_verifier.verifier_identity()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_session_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_session_peer(
        &self,
        session: &ClosedExecutionVerifiedSession,
        binding: &P::PeerBinding,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        self.validate_handle(binding)?;
        if session.peer_handle_identity() != binding.handle_identity() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_session_peer_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_request(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        self.validate_session(session)?;
        if !request.is_self_consistent()
            || request.provider_identity() != self.provider.descriptor().provider_identity()
            || request.session_identity() != session.identity()
            || request.requirement_set_identity() != session.requirements().identity()
            || request.deadline_monotonic_ns() > session.deadline_monotonic_ns()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_request_session_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_handle<H: ClosedExecutionProviderHandle + ?Sized>(
        &self,
        handle: &H,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if handle.provider_identity() != self.provider.descriptor().provider_identity() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_provider_handle_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_process_set(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
        process_set: &P::ProcessSet,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        self.validate_handle(process_set)?;
        if process_set.session_identity() != session.identity()
            || process_set.request_identity() != request.identity()
            || process_set.deadline_monotonic_ns() != request.deadline_monotonic_ns()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_process_set_request_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_plan(
        &self,
        session: &ClosedExecutionVerifiedSession,
        request: &ClosedExecutionRequest,
        plan: &P::SpawnPlan,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if plan.provider_identity() != self.provider.descriptor().provider_identity()
            || plan.session_identity() != session.identity()
            || plan.requirement_set_identity() != request.requirement_set_identity()
            || plan.request_identity() != request.identity()
            || plan.deadline_monotonic_ns() != request.deadline_monotonic_ns()
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_spawn_plan_binding_invalid",
            ));
        }
        Ok(())
    }

    fn validate_lifecycle_observation<
        O: ClosedExecutionLifecycleObservation,
        H: ClosedExecutionProviderHandle + ?Sized,
    >(
        &self,
        observation: &O,
        subject: &H,
        verifier_started_monotonic_ns: u64,
        verifier_completed_monotonic_ns: u64,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if verifier_started_monotonic_ns == 0
            || verifier_started_monotonic_ns > verifier_completed_monotonic_ns
            || observation.provider_identity() != self.provider.descriptor().provider_identity()
            || observation.subject_identity() != subject.handle_identity()
            || observation.observed_monotonic_ns() < verifier_started_monotonic_ns
            || observation.observed_monotonic_ns() > verifier_completed_monotonic_ns
            || observation.evidence_refs().is_empty()
            || observation.observation_identity()
                != &derive_lifecycle_observation_identity(
                    self.provider.descriptor().provider_identity(),
                    subject.handle_identity(),
                    observation.observed_monotonic_ns(),
                    observation.evidence_refs(),
                )
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_lifecycle_observation_binding_invalid",
            ));
        }
        Ok(())
    }

    fn consume_challenge_once(
        &self,
        challenge: &ClosedExecutionProbeChallenge,
        session_deadline_monotonic_ns: u64,
    ) -> Result<ClosedExecutionContentIdentity, ClosedExecutionProviderContractError> {
        let started = self.begin_operation(session_deadline_monotonic_ns)?;
        let consumption_identity = self
            .evidence_verifier
            .consume_challenge_once(challenge, session_deadline_monotonic_ns)?;
        self.complete_operation(started, session_deadline_monotonic_ns)?;
        let expected_identity = derive_challenge_consumption_identity(
            self.clock.verification_authority_identity(),
            self.evidence_verifier.verifier_identity(),
            self.clock.clock_identity(),
            challenge.identity(),
            session_deadline_monotonic_ns,
        );
        if consumption_identity != expected_identity {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_challenge_consumption_binding_invalid",
            ));
        }
        Ok(consumption_identity)
    }

    fn verify_evidence(
        &self,
        context_identity: &ClosedExecutionContentIdentity,
        evidence_refs: &[ClosedExecutionContentIdentity],
        deadline_monotonic_ns: u64,
    ) -> Result<(), ClosedExecutionProviderContractError> {
        if evidence_refs.is_empty() {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_evidence_missing",
            ));
        }
        let started = self.begin_operation(deadline_monotonic_ns)?;
        self.evidence_verifier
            .verify_evidence(context_identity, evidence_refs)?;
        self.complete_operation(started, deadline_monotonic_ns)?;
        Ok(())
    }

    fn begin_operation(
        &self,
        deadline_monotonic_ns: u64,
    ) -> Result<u64, ClosedExecutionProviderContractError> {
        let started = self.clock.now_monotonic_ns();
        if started == 0 || deadline_monotonic_ns == 0 || started >= deadline_monotonic_ns {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_verifier_deadline_expired",
            ));
        }
        Ok(started)
    }

    fn complete_operation(
        &self,
        started_monotonic_ns: u64,
        deadline_monotonic_ns: u64,
    ) -> Result<u64, ClosedExecutionProviderContractError> {
        let completed = self.clock.now_monotonic_ns();
        if completed < started_monotonic_ns || completed >= deadline_monotonic_ns {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_verifier_deadline_expired",
            ));
        }
        Ok(completed)
    }
}

fn validate_parameters(
    parameters: &BTreeMap<String, String>,
) -> Result<(), ClosedExecutionProviderContractError> {
    for (key, value) in parameters {
        if key.is_empty()
            || key.len() > MAX_PARAMETER_KEY_BYTES
            || !key.bytes().all(|byte| byte.is_ascii_graphic())
            || value.is_empty()
            || value.len() > MAX_PARAMETER_VALUE_BYTES
        {
            return Err(ClosedExecutionProviderContractError::new(
                "closed_execution_requirement_parameter_invalid",
            ));
        }
    }
    Ok(())
}

fn derive_credential_snapshot_identity(
    provider_identity: &ClosedExecutionContentIdentity,
    peer_handle_identity: &ClosedExecutionContentIdentity,
    challenge_identity: &ClosedExecutionContentIdentity,
    observed_monotonic_ns: u64,
    claims: &[ClosedExecutionCredentialClaim],
) -> ClosedExecutionContentIdentity {
    let observed_bytes = observed_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        provider_identity.as_str().as_bytes(),
        peer_handle_identity.as_str().as_bytes(),
        challenge_identity.as_str().as_bytes(),
        &observed_bytes,
    ];
    for claim in claims {
        fields.push(claim.claim_id.as_str().as_bytes());
        fields.push(claim.value_identity.as_str().as_bytes());
        fields.push(claim.evidence_ref.as_str().as_bytes());
    }
    hash_identity(CREDENTIAL_SNAPSHOT_DOMAIN, &fields)
}

fn derive_challenge_consumption_identity(
    verification_authority_identity: &ClosedExecutionContentIdentity,
    evidence_verifier_identity: &ClosedExecutionContentIdentity,
    verifier_clock_identity: &ClosedExecutionContentIdentity,
    challenge_identity: &ClosedExecutionContentIdentity,
    session_deadline_monotonic_ns: u64,
) -> ClosedExecutionContentIdentity {
    hash_identity(
        CHALLENGE_CONSUMPTION_DOMAIN,
        &[
            verification_authority_identity.as_str().as_bytes(),
            evidence_verifier_identity.as_str().as_bytes(),
            verifier_clock_identity.as_str().as_bytes(),
            challenge_identity.as_str().as_bytes(),
            &session_deadline_monotonic_ns.to_be_bytes(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_session_identity(
    descriptor: &ClosedExecutionProviderDescriptor,
    challenge: &ClosedExecutionProbeChallenge,
    manifest: &ClosedExecutionProviderCapabilityManifest,
    requirement_set: &ClosedExecutionRequirementSet,
    credential_snapshot: &ClosedExecutionCredentialSnapshot,
    verification_authority_identity: &ClosedExecutionContentIdentity,
    verifier_clock_identity: &ClosedExecutionContentIdentity,
    evidence_verifier_identity: &ClosedExecutionContentIdentity,
    challenge_consumption_identity: &ClosedExecutionContentIdentity,
    peer_handle_identity: &ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
) -> ClosedExecutionContentIdentity {
    derive_session_identity_from_fields(
        descriptor.provider_identity(),
        descriptor.descriptor_identity(),
        descriptor.implementation_identity(),
        challenge.identity(),
        manifest.identity(),
        requirement_set.identity(),
        credential_snapshot.identity(),
        verification_authority_identity,
        verifier_clock_identity,
        evidence_verifier_identity,
        challenge_consumption_identity,
        peer_handle_identity,
        deadline_monotonic_ns,
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_session_identity_from_fields(
    provider_identity: &ClosedExecutionContentIdentity,
    descriptor_identity: &ClosedExecutionContentIdentity,
    implementation_identity: &ClosedExecutionContentIdentity,
    challenge_identity: &ClosedExecutionContentIdentity,
    manifest_identity: &ClosedExecutionContentIdentity,
    requirement_set_identity: &ClosedExecutionContentIdentity,
    credential_snapshot_identity: &ClosedExecutionContentIdentity,
    verification_authority_identity: &ClosedExecutionContentIdentity,
    verifier_clock_identity: &ClosedExecutionContentIdentity,
    evidence_verifier_identity: &ClosedExecutionContentIdentity,
    challenge_consumption_identity: &ClosedExecutionContentIdentity,
    peer_handle_identity: &ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
) -> ClosedExecutionContentIdentity {
    let deadline = deadline_monotonic_ns.to_be_bytes();
    hash_identity(
        SESSION_DOMAIN,
        &[
            provider_identity.as_str().as_bytes(),
            descriptor_identity.as_str().as_bytes(),
            implementation_identity.as_str().as_bytes(),
            challenge_identity.as_str().as_bytes(),
            manifest_identity.as_str().as_bytes(),
            requirement_set_identity.as_str().as_bytes(),
            credential_snapshot_identity.as_str().as_bytes(),
            verification_authority_identity.as_str().as_bytes(),
            verifier_clock_identity.as_str().as_bytes(),
            evidence_verifier_identity.as_str().as_bytes(),
            challenge_consumption_identity.as_str().as_bytes(),
            peer_handle_identity.as_str().as_bytes(),
            &deadline,
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn derive_execution_request_identity(
    session_identity: &ClosedExecutionContentIdentity,
    provider_identity: &ClosedExecutionContentIdentity,
    requirement_set_identity: &ClosedExecutionContentIdentity,
    invocation_identity: &ClosedExecutionContentIdentity,
    executable_identity: &ClosedExecutionContentIdentity,
    execution_closure_identity: &ClosedExecutionContentIdentity,
    execution_policy_identity: &ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
    parameters: &BTreeMap<String, String>,
) -> ClosedExecutionContentIdentity {
    let deadline = deadline_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        session_identity.as_str().as_bytes(),
        provider_identity.as_str().as_bytes(),
        requirement_set_identity.as_str().as_bytes(),
        invocation_identity.as_str().as_bytes(),
        executable_identity.as_str().as_bytes(),
        execution_closure_identity.as_str().as_bytes(),
        execution_policy_identity.as_str().as_bytes(),
        &deadline,
    ];
    for (key, value) in parameters {
        fields.push(key.as_bytes());
        fields.push(value.as_bytes());
    }
    hash_identity(EXECUTION_REQUEST_DOMAIN, &fields)
}

fn derive_record_context_identity(
    session_identity: &ClosedExecutionContentIdentity,
    sequence: u64,
    predecessor_identity: &ClosedExecutionContentIdentity,
    direction: ClosedExecutionRecordDirection,
    deadline_monotonic_ns: u64,
) -> ClosedExecutionContentIdentity {
    let sequence = sequence.to_be_bytes();
    let direction = [direction.wire_value()];
    let deadline = deadline_monotonic_ns.to_be_bytes();
    hash_identity(
        RECORD_CONTEXT_DOMAIN,
        &[
            session_identity.as_str().as_bytes(),
            &sequence,
            predecessor_identity.as_str().as_bytes(),
            &direction,
            &deadline,
        ],
    )
}

fn derive_record_transport_identity(
    provider_identity: &ClosedExecutionContentIdentity,
    peer_handle_identity: &ClosedExecutionContentIdentity,
    context: &ClosedExecutionRecordContext,
    record_identity: &ClosedExecutionContentIdentity,
    completed_monotonic_ns: u64,
    evidence_refs: &[ClosedExecutionContentIdentity],
) -> ClosedExecutionContentIdentity {
    let completed = completed_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        provider_identity.as_str().as_bytes(),
        peer_handle_identity.as_str().as_bytes(),
        context.identity().as_str().as_bytes(),
        record_identity.as_str().as_bytes(),
        &completed,
    ];
    for evidence_ref in evidence_refs {
        fields.push(evidence_ref.as_str().as_bytes());
    }
    hash_identity(RECORD_TRANSPORT_DOMAIN, &fields)
}

#[allow(clippy::too_many_arguments)]
fn derive_process_set_witness_identity(
    provider_identity: &ClosedExecutionContentIdentity,
    process_set_identity: &ClosedExecutionContentIdentity,
    session_identity: &ClosedExecutionContentIdentity,
    request_identity: &ClosedExecutionContentIdentity,
    deadline_monotonic_ns: u64,
    evidence_refs: &[ClosedExecutionContentIdentity],
) -> ClosedExecutionContentIdentity {
    let deadline = deadline_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        provider_identity.as_str().as_bytes(),
        process_set_identity.as_str().as_bytes(),
        session_identity.as_str().as_bytes(),
        request_identity.as_str().as_bytes(),
        &deadline,
    ];
    for evidence_ref in evidence_refs {
        fields.push(evidence_ref.as_str().as_bytes());
    }
    hash_identity(PROCESS_SET_WITNESS_DOMAIN, &fields)
}

#[allow(clippy::too_many_arguments)]
fn derive_spawn_observation_identity(
    provider_identity: &ClosedExecutionContentIdentity,
    process_identity: &ClosedExecutionContentIdentity,
    session_identity: &ClosedExecutionContentIdentity,
    request_identity: &ClosedExecutionContentIdentity,
    spawn_plan_identity: &ClosedExecutionContentIdentity,
    process_set_identity: &ClosedExecutionContentIdentity,
    spawned_monotonic_ns: u64,
    evidence_refs: &[ClosedExecutionContentIdentity],
) -> ClosedExecutionContentIdentity {
    let spawned = spawned_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        provider_identity.as_str().as_bytes(),
        process_identity.as_str().as_bytes(),
        session_identity.as_str().as_bytes(),
        request_identity.as_str().as_bytes(),
        spawn_plan_identity.as_str().as_bytes(),
        process_set_identity.as_str().as_bytes(),
        &spawned,
    ];
    for evidence_ref in evidence_refs {
        fields.push(evidence_ref.as_str().as_bytes());
    }
    hash_identity(SPAWN_OBSERVATION_DOMAIN, &fields)
}

fn derive_lifecycle_observation_identity(
    provider_identity: &ClosedExecutionContentIdentity,
    subject_identity: &ClosedExecutionContentIdentity,
    observed_monotonic_ns: u64,
    evidence_refs: &[ClosedExecutionContentIdentity],
) -> ClosedExecutionContentIdentity {
    let observed = observed_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        provider_identity.as_str().as_bytes(),
        subject_identity.as_str().as_bytes(),
        &observed,
    ];
    for evidence_ref in evidence_refs {
        fields.push(evidence_ref.as_str().as_bytes());
    }
    hash_identity(LIFECYCLE_OBSERVATION_DOMAIN, &fields)
}

fn derive_requirement_identity(
    obligation_id: &ClosedExecutionMechanismId,
    parameters: &BTreeMap<String, String>,
) -> ClosedExecutionContentIdentity {
    let mut fields = vec![obligation_id.as_str().as_bytes()];
    for (key, value) in parameters {
        fields.push(key.as_bytes());
        fields.push(value.as_bytes());
    }
    hash_identity(REQUIREMENT_DOMAIN, &fields)
}

fn derive_observation_identity(
    capability_id: &ClosedExecutionMechanismId,
    outcome: ClosedExecutionCapabilityOutcome,
    satisfies_requirements: &BTreeSet<ClosedExecutionContentIdentity>,
    evidence_refs: &[ClosedExecutionContentIdentity],
) -> ClosedExecutionContentIdentity {
    let outcome = [outcome.wire_value()];
    let mut fields = vec![capability_id.as_str().as_bytes(), &outcome];
    for requirement_id in satisfies_requirements {
        fields.push(requirement_id.as_str().as_bytes());
    }
    for evidence_ref in evidence_refs {
        fields.push(evidence_ref.as_str().as_bytes());
    }
    hash_identity(OBSERVATION_DOMAIN, &fields)
}

fn derive_blocking_gaps(
    requirements: &ClosedExecutionRequirementSet,
    observations: &[ClosedExecutionCapabilityObservation],
) -> Vec<String> {
    requirements
        .requirements
        .iter()
        .filter(|requirement| {
            !observations.iter().any(|observation| {
                observation.outcome == ClosedExecutionCapabilityOutcome::Observed
                    && observation
                        .satisfies_requirements
                        .contains(&requirement.requirement_identity)
            })
        })
        .map(|requirement| {
            format!(
                "closed_execution_requirement_unobserved:{}:{}",
                requirement.obligation_id.as_str(),
                requirement.requirement_identity.as_str()
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn derive_manifest_identity(
    descriptor: &ClosedExecutionProviderDescriptor,
    challenge: &ClosedExecutionProbeChallenge,
    requirements: &ClosedExecutionRequirementSet,
    probe_started_monotonic_ns: u64,
    probe_completed_monotonic_ns: u64,
    observations: &[ClosedExecutionCapabilityObservation],
    blocking_gaps: &[String],
) -> ClosedExecutionContentIdentity {
    let started = probe_started_monotonic_ns.to_be_bytes();
    let completed = probe_completed_monotonic_ns.to_be_bytes();
    let mut fields = vec![
        descriptor.descriptor_identity.as_str().as_bytes(),
        descriptor.provider_identity.as_str().as_bytes(),
        challenge.challenge_identity.as_str().as_bytes(),
        requirements.requirement_set_identity.as_str().as_bytes(),
        &started,
        &completed,
    ];
    for observation in observations {
        fields.push(observation.observation_identity.as_str().as_bytes());
    }
    for gap in blocking_gaps {
        fields.push(gap.as_bytes());
    }
    hash_identity(MANIFEST_DOMAIN, &fields)
}

fn hash_identity(domain: &[u8], fields: &[&[u8]]) -> ClosedExecutionContentIdentity {
    let mut hasher = Sha256::new();
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    ClosedExecutionContentIdentity(format!("sha256:{}", hex::encode(digest)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn identity(label: &str) -> ClosedExecutionContentIdentity {
        ClosedExecutionContentIdentity::hash_bytes(ID_DOMAIN, label.as_bytes())
    }

    fn mechanism(value: &str) -> ClosedExecutionMechanismId {
        ClosedExecutionMechanismId::parse(value).unwrap()
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct TestProviderError;

    impl fmt::Display for TestProviderError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("test_provider_error")
        }
    }

    impl Error for TestProviderError {}

    #[derive(Debug)]
    struct TestClock {
        clock_identity: ClosedExecutionContentIdentity,
        verification_authority_identity: ClosedExecutionContentIdentity,
    }

    impl Default for TestClock {
        fn default() -> Self {
            Self {
                clock_identity: identity("test-verifier-clock"),
                verification_authority_identity: identity("test-verification-authority"),
            }
        }
    }

    impl ClosedExecutionMonotonicClock for TestClock {
        fn clock_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.clock_identity
        }

        fn verification_authority_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.verification_authority_identity
        }

        fn now_monotonic_ns(&self) -> u64 {
            20
        }
    }

    #[derive(Debug)]
    struct TestEvidenceVerifier {
        verifier_identity: ClosedExecutionContentIdentity,
        verification_authority_identity: ClosedExecutionContentIdentity,
        bound_clock_identity: ClosedExecutionContentIdentity,
        rejected_ref: Option<ClosedExecutionContentIdentity>,
        consumed_challenges: Mutex<BTreeSet<ClosedExecutionContentIdentity>>,
    }

    impl Default for TestEvidenceVerifier {
        fn default() -> Self {
            Self {
                verifier_identity: identity("test-evidence-verifier"),
                verification_authority_identity: identity("test-verification-authority"),
                bound_clock_identity: identity("test-verifier-clock"),
                rejected_ref: None,
                consumed_challenges: Mutex::new(BTreeSet::new()),
            }
        }
    }

    impl ClosedExecutionEvidenceVerifier for TestEvidenceVerifier {
        fn verifier_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.verifier_identity
        }

        fn verification_authority_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.verification_authority_identity
        }

        fn bound_clock_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.bound_clock_identity
        }

        fn consume_challenge_once(
            &self,
            challenge: &ClosedExecutionProbeChallenge,
            session_deadline_monotonic_ns: u64,
        ) -> Result<ClosedExecutionContentIdentity, ClosedExecutionProviderContractError> {
            if !self
                .consumed_challenges
                .lock()
                .unwrap()
                .insert(challenge.identity().clone())
            {
                return Err(ClosedExecutionProviderContractError::new(
                    "closed_execution_challenge_replayed",
                ));
            }
            Ok(derive_challenge_consumption_identity(
                &self.verification_authority_identity,
                &self.verifier_identity,
                &self.bound_clock_identity,
                challenge.identity(),
                session_deadline_monotonic_ns,
            ))
        }

        fn verify_evidence(
            &self,
            _context_identity: &ClosedExecutionContentIdentity,
            evidence_refs: &[ClosedExecutionContentIdentity],
        ) -> Result<(), ClosedExecutionProviderContractError> {
            if evidence_refs.is_empty()
                || self
                    .rejected_ref
                    .as_ref()
                    .is_some_and(|rejected| evidence_refs.contains(rejected))
            {
                return Err(ClosedExecutionProviderContractError::new(
                    "closed_execution_test_evidence_unresolved",
                ));
            }
            Ok(())
        }
    }

    #[derive(Debug, Clone)]
    struct TestHandle {
        provider_identity: ClosedExecutionContentIdentity,
        handle_identity: ClosedExecutionContentIdentity,
        session_identity: ClosedExecutionContentIdentity,
        spawn_observation_identity: ClosedExecutionContentIdentity,
        spawn_evidence_refs: Vec<ClosedExecutionContentIdentity>,
        spawned_monotonic_ns: u64,
        request_identity: ClosedExecutionContentIdentity,
        spawn_plan_identity: ClosedExecutionContentIdentity,
        process_set_identity: ClosedExecutionContentIdentity,
        deadline_monotonic_ns: u64,
        containment_witness_identity: ClosedExecutionContentIdentity,
        containment_evidence_refs: Vec<ClosedExecutionContentIdentity>,
        replay_record_observation: bool,
        last_record_observation:
            std::sync::Arc<Mutex<Option<ClosedExecutionRecordTransportObservation>>>,
        records: std::sync::Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl ClosedExecutionProcessSetHandle for TestHandle {
        fn session_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.session_identity
        }

        fn request_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.request_identity
        }

        fn deadline_monotonic_ns(&self) -> u64 {
            self.deadline_monotonic_ns
        }

        fn containment_witness_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.containment_witness_identity
        }

        fn containment_evidence_refs(&self) -> &[ClosedExecutionContentIdentity] {
            &self.containment_evidence_refs
        }
    }

    impl ClosedExecutionProcessHandle for TestHandle {
        fn session_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.session_identity
        }

        fn spawned_monotonic_ns(&self) -> u64 {
            self.spawned_monotonic_ns
        }

        fn spawn_observation_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.spawn_observation_identity
        }

        fn spawn_evidence_refs(&self) -> &[ClosedExecutionContentIdentity] {
            &self.spawn_evidence_refs
        }

        fn request_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.request_identity
        }

        fn spawn_plan_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.spawn_plan_identity
        }

        fn process_set_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.process_set_identity
        }

        fn deadline_monotonic_ns(&self) -> u64 {
            self.deadline_monotonic_ns
        }
    }

    impl ClosedExecutionProviderHandle for TestHandle {
        fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.provider_identity
        }

        fn handle_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.handle_identity
        }
    }

    impl ClosedExecutionPeerBinding for TestHandle {
        type Error = TestProviderError;

        fn credential_snapshot(
            &self,
            challenge: &ClosedExecutionProbeChallenge,
        ) -> Result<ClosedExecutionCredentialSnapshot, Self::Error> {
            ClosedExecutionCredentialSnapshot::new(
                self.provider_identity.clone(),
                self.handle_identity.clone(),
                challenge.identity().clone(),
                20,
                vec![ClosedExecutionCredentialClaim::new(
                    mechanism("example.identity.claim.v1"),
                    identity("claim-value"),
                    identity("claim-evidence"),
                )],
            )
            .map_err(|_| TestProviderError)
        }

        fn ensure_live(&self) -> Result<(), Self::Error> {
            Ok(())
        }

        fn send_record(
            &self,
            context: &ClosedExecutionRecordContext,
            record: &[u8],
        ) -> Result<ClosedExecutionRecordTransportObservation, Self::Error> {
            if self.replay_record_observation {
                if let Some(observation) = self.last_record_observation.lock().unwrap().clone() {
                    return Ok(observation);
                }
            }
            self.records.lock().unwrap().push(record.to_vec());
            let observation = ClosedExecutionRecordTransportObservation::new(
                self.provider_identity.clone(),
                self.handle_identity.clone(),
                context,
                record,
                20,
                vec![identity("send-evidence")],
            )
            .map_err(|_| TestProviderError)?;
            *self.last_record_observation.lock().unwrap() = Some(observation.clone());
            Ok(observation)
        }

        fn receive_record(
            &self,
            context: &ClosedExecutionRecordContext,
        ) -> Result<(Vec<u8>, ClosedExecutionRecordTransportObservation), Self::Error> {
            let record = self
                .records
                .lock()
                .unwrap()
                .pop()
                .ok_or(TestProviderError)?;
            let observation = ClosedExecutionRecordTransportObservation::new(
                self.provider_identity.clone(),
                self.handle_identity.clone(),
                context,
                &record,
                20,
                vec![identity("receive-evidence")],
            )
            .map_err(|_| TestProviderError)?;
            Ok((record, observation))
        }
    }

    #[derive(Debug, Clone)]
    struct TestSpawnPlan {
        provider_identity: ClosedExecutionContentIdentity,
        plan_identity: ClosedExecutionContentIdentity,
        session_identity: ClosedExecutionContentIdentity,
        requirement_set_identity: ClosedExecutionContentIdentity,
        request_identity: ClosedExecutionContentIdentity,
        deadline_monotonic_ns: u64,
    }

    impl ClosedExecutionSpawnPlan for TestSpawnPlan {
        fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.provider_identity
        }

        fn plan_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.plan_identity
        }

        fn session_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.session_identity
        }

        fn requirement_set_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.requirement_set_identity
        }

        fn request_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.request_identity
        }

        fn deadline_monotonic_ns(&self) -> u64 {
            self.deadline_monotonic_ns
        }
    }

    #[derive(Debug, Clone)]
    struct TestLifecycleObservation {
        provider_identity: ClosedExecutionContentIdentity,
        subject_identity: ClosedExecutionContentIdentity,
        observation_identity: ClosedExecutionContentIdentity,
        observed_monotonic_ns: u64,
        evidence_refs: Vec<ClosedExecutionContentIdentity>,
    }

    impl ClosedExecutionLifecycleObservation for TestLifecycleObservation {
        fn provider_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.provider_identity
        }

        fn subject_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.subject_identity
        }

        fn observation_identity(&self) -> &ClosedExecutionContentIdentity {
            &self.observation_identity
        }

        fn observed_monotonic_ns(&self) -> u64 {
            self.observed_monotonic_ns
        }

        fn evidence_refs(&self) -> &[ClosedExecutionContentIdentity] {
            &self.evidence_refs
        }
    }

    #[derive(Debug)]
    struct TestProvider {
        descriptor: ClosedExecutionProviderDescriptor,
        capability_id: ClosedExecutionMechanismId,
        covered_requirements: BTreeSet<ClosedExecutionContentIdentity>,
        outcome: ClosedExecutionCapabilityOutcome,
        forge_spawn_observation: bool,
        replay_record_observation: bool,
        lifecycle_observed_monotonic_ns: u64,
    }

    impl TestProvider {
        fn handle(&self, label: &str) -> TestHandle {
            TestHandle {
                provider_identity: self.descriptor.provider_identity.clone(),
                handle_identity: identity(label),
                session_identity: identity("unbound-session"),
                spawn_observation_identity: identity(&format!("{label}-spawn-observation")),
                spawn_evidence_refs: vec![identity(&format!("{label}-spawn-evidence"))],
                spawned_monotonic_ns: 20,
                request_identity: identity("unbound-request"),
                spawn_plan_identity: identity("unbound-plan"),
                process_set_identity: identity("unbound-process-set"),
                deadline_monotonic_ns: 100,
                containment_witness_identity: identity("unbound-containment-witness"),
                containment_evidence_refs: vec![identity(&format!("{label}-containment-evidence"))],
                replay_record_observation: self.replay_record_observation,
                last_record_observation: Default::default(),
                records: Default::default(),
            }
        }

        fn lifecycle(&self, subject: &TestHandle, label: &str) -> TestLifecycleObservation {
            let evidence_refs = vec![identity(label), identity("lifecycle-evidence")];
            TestLifecycleObservation {
                provider_identity: self.descriptor.provider_identity.clone(),
                subject_identity: subject.handle_identity.clone(),
                observation_identity: derive_lifecycle_observation_identity(
                    &self.descriptor.provider_identity,
                    &subject.handle_identity,
                    self.lifecycle_observed_monotonic_ns,
                    &evidence_refs,
                ),
                observed_monotonic_ns: self.lifecycle_observed_monotonic_ns,
                evidence_refs,
            }
        }
    }

    impl ClosedExecutionProvider for TestProvider {
        type Error = TestProviderError;
        type PeerEndpoint = ();
        type PeerBinding = TestHandle;
        type SpawnPlan = TestSpawnPlan;
        type ProcessSet = TestHandle;
        type Process = TestHandle;
        type TerminationObservation = TestLifecycleObservation;
        type ExitObservation = TestLifecycleObservation;

        fn descriptor(&self) -> &ClosedExecutionProviderDescriptor {
            &self.descriptor
        }

        fn probe(
            &self,
            challenge: &ClosedExecutionProbeChallenge,
            requirements: &ClosedExecutionRequirementSet,
        ) -> Result<ClosedExecutionProviderCapabilityManifest, Self::Error> {
            let observation = ClosedExecutionCapabilityObservation::new(
                self.capability_id.clone(),
                self.outcome,
                self.covered_requirements.clone(),
                vec![identity("probe-evidence")],
            )
            .map_err(|_| TestProviderError)?;
            ClosedExecutionProviderCapabilityManifest::new(
                &self.descriptor,
                challenge,
                requirements,
                20,
                20,
                vec![observation],
            )
            .map_err(|_| TestProviderError)
        }

        fn observe_peer(
            &self,
            _endpoint: Self::PeerEndpoint,
        ) -> Result<Self::PeerBinding, Self::Error> {
            Ok(self.handle("peer"))
        }

        fn create_process_set(
            &self,
            request: &ClosedExecutionRequest,
        ) -> Result<Self::ProcessSet, Self::Error> {
            if request.provider_identity != self.descriptor.provider_identity {
                return Err(TestProviderError);
            }
            let mut process_set = self.handle("process-set");
            process_set.session_identity = request.session_identity.clone();
            process_set.request_identity = request.request_identity.clone();
            process_set.deadline_monotonic_ns = request.deadline_monotonic_ns;
            process_set.containment_witness_identity = derive_process_set_witness_identity(
                &process_set.provider_identity,
                &process_set.handle_identity,
                &process_set.session_identity,
                &process_set.request_identity,
                process_set.deadline_monotonic_ns,
                &process_set.containment_evidence_refs,
            );
            Ok(process_set)
        }

        fn prepare_spawn(
            &self,
            request: &ClosedExecutionRequest,
            process_set: &Self::ProcessSet,
        ) -> Result<Self::SpawnPlan, Self::Error> {
            if request.provider_identity != self.descriptor.provider_identity
                || process_set.provider_identity != self.descriptor.provider_identity
            {
                return Err(TestProviderError);
            }
            Ok(TestSpawnPlan {
                provider_identity: self.descriptor.provider_identity.clone(),
                plan_identity: identity("plan"),
                session_identity: request.session_identity.clone(),
                requirement_set_identity: request.requirement_set_identity.clone(),
                request_identity: request.request_identity.clone(),
                deadline_monotonic_ns: request.deadline_monotonic_ns,
            })
        }

        fn spawn(
            &self,
            plan: &Self::SpawnPlan,
            process_set: &Self::ProcessSet,
        ) -> Result<Self::Process, Self::Error> {
            if plan.provider_identity != self.descriptor.provider_identity
                || process_set.provider_identity != self.descriptor.provider_identity
            {
                return Err(TestProviderError);
            }
            let mut process = self.handle("process");
            process.session_identity = plan.session_identity.clone();
            process.request_identity = plan.request_identity.clone();
            process.spawn_plan_identity = plan.plan_identity.clone();
            process.process_set_identity = process_set.handle_identity.clone();
            process.deadline_monotonic_ns = plan.deadline_monotonic_ns;
            process.spawn_observation_identity = derive_spawn_observation_identity(
                &process.provider_identity,
                &process.handle_identity,
                &process.session_identity,
                &process.request_identity,
                &process.spawn_plan_identity,
                &process.process_set_identity,
                process.spawned_monotonic_ns(),
                &process.spawn_evidence_refs,
            );
            if self.forge_spawn_observation {
                process.spawn_observation_identity = identity("forged-spawn-observation");
            }
            Ok(process)
        }

        fn terminate(
            &self,
            process_set: &Self::ProcessSet,
            _deadline_monotonic_ns: u64,
        ) -> Result<Self::TerminationObservation, Self::Error> {
            Ok(self.lifecycle(process_set, "termination"))
        }

        fn observe_exit(
            &self,
            process: &Self::Process,
            _deadline_monotonic_ns: u64,
        ) -> Result<Self::ExitObservation, Self::Error> {
            Ok(self.lifecycle(process, "exit"))
        }
    }

    fn requirements() -> ClosedExecutionRequirementSet {
        ClosedExecutionRequirementSet::new(vec![
            ClosedExecutionRequirement::new(
                mechanism("synthi.closed_execution.obligation.authenticated_peer.v1"),
                BTreeMap::new(),
            )
            .unwrap(),
            ClosedExecutionRequirement::new(
                mechanism("synthi.closed_execution.obligation.bounded_process_set.v1"),
                BTreeMap::new(),
            )
            .unwrap(),
        ])
        .unwrap()
    }

    fn provider(
        capability_id: &str,
        covered_requirements: BTreeSet<ClosedExecutionContentIdentity>,
        outcome: ClosedExecutionCapabilityOutcome,
    ) -> TestProvider {
        TestProvider {
            descriptor: ClosedExecutionProviderDescriptor::new(
                identity(capability_id),
                identity("implementation-bytes"),
            ),
            capability_id: mechanism(capability_id),
            covered_requirements,
            outcome,
            forge_spawn_observation: false,
            replay_record_observation: false,
            lifecycle_observed_monotonic_ns: 20,
        }
    }

    fn verified_provider<'a>(
        provider: &'a TestProvider,
        clock: &'a TestClock,
        evidence_verifier: &'a TestEvidenceVerifier,
    ) -> VerifiedClosedExecutionProvider<'a, TestProvider, TestClock, TestEvidenceVerifier> {
        VerifiedClosedExecutionProvider::try_new(provider, clock, evidence_verifier).unwrap()
    }

    fn execution_request(
        session: &ClosedExecutionVerifiedSession,
        label: &str,
    ) -> ClosedExecutionRequest {
        ClosedExecutionRequest::new(
            session,
            identity(&format!("{label}-invocation")),
            identity(&format!("{label}-executable")),
            identity(&format!("{label}-closure")),
            identity(&format!("{label}-policy")),
            90,
            BTreeMap::new(),
        )
        .unwrap()
    }

    fn invocation_contract_code<E: Error + Send + Sync + 'static>(
        error: ClosedExecutionProviderInvocationError<E>,
    ) -> &'static str {
        match error {
            ClosedExecutionProviderInvocationError::Contract(error) => error.code(),
            ClosedExecutionProviderInvocationError::Provider(_) => {
                panic!("expected contract rejection")
            }
        }
    }

    #[test]
    fn unfamiliar_provider_capability_covers_open_vocabulary_obligations() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect();
        let provider = provider(
            "example.closed_execution.mechanic.never_seen_before.v73",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let challenge = ClosedExecutionProbeChallenge::new(identity("challenge"), 100).unwrap();
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let verified = verified_provider(&provider, &clock, &evidence_verifier);
        let (peer, manifest, snapshot, mut session) = verified
            .establish_session((), &challenge, &requirements, 100)
            .unwrap();

        assert!(manifest.covers_requested_obligations());
        assert!(manifest.blocking_gaps().is_empty());
        assert!(!manifest.accepted_for_gpu_hmr());
        assert!(!manifest.gpu_hmr_success());
        assert_eq!(
            manifest.provider_identity(),
            provider.descriptor().provider_identity()
        );

        assert!(!snapshot.identity().as_str().is_empty());
        verified
            .send_record(&mut session, &peer, b"record")
            .unwrap();
        assert_eq!(
            verified.receive_record(&mut session, &peer).unwrap().0,
            b"record"
        );

        let request = ClosedExecutionRequest::new(
            &session,
            identity("invocation"),
            identity("executable"),
            identity("execution-closure"),
            identity("execution-policy"),
            90,
            BTreeMap::new(),
        )
        .unwrap();
        let process_set = verified.create_process_set(&session, &request).unwrap();
        let plan = verified
            .prepare_spawn(&session, &request, &process_set)
            .unwrap();
        let process = verified
            .spawn(&session, &request, &plan, &process_set)
            .unwrap();
        assert_eq!(
            verified
                .terminate(&session, &process_set)
                .unwrap()
                .provider_identity(),
            provider.descriptor().provider_identity()
        );
        assert_eq!(
            verified
                .observe_exit(&session, &process)
                .unwrap()
                .subject_identity(),
            process.handle_identity()
        );
    }

    #[test]
    fn missing_mechanics_report_obligation_ids_not_provider_labels() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect();
        let provider = provider(
            "another.namespace.closed_execution.capability.v2",
            covered,
            ClosedExecutionCapabilityOutcome::Blocked,
        );
        let challenge = ClosedExecutionProbeChallenge::new(identity("challenge"), 100).unwrap();
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let manifest = verified_provider(&provider, &clock, &evidence_verifier)
            .probe(&challenge, &requirements)
            .unwrap();

        assert!(!manifest.covers_requested_obligations());
        assert_eq!(manifest.blocking_gaps().len(), 2);
        assert!(manifest.blocking_gaps().iter().all(|gap| {
            gap.starts_with(
                "closed_execution_requirement_unobserved:synthi.closed_execution.obligation.",
            ) && !gap.contains(provider.capability_id.as_str())
        }));
    }

    #[test]
    fn requirement_and_capability_sets_are_canonical_and_not_vacuous() {
        assert_eq!(
            ClosedExecutionMechanismId::parse("unversioned")
                .unwrap_err()
                .code(),
            "closed_execution_mechanism_id_unversioned"
        );
        assert_eq!(
            ClosedExecutionRequirementSet::new(Vec::new())
                .unwrap_err()
                .code(),
            "closed_execution_requirement_set_empty"
        );

        let requirement =
            ClosedExecutionRequirement::new(mechanism("example.obligation.v1"), BTreeMap::new())
                .unwrap();
        let requirement_identity = requirement.requirement_identity().clone();
        assert_eq!(
            ClosedExecutionRequirementSet::new(vec![requirement.clone(), requirement.clone()])
                .unwrap_err()
                .code(),
            "closed_execution_requirement_duplicate"
        );

        let observation = ClosedExecutionCapabilityObservation::new(
            mechanism("example.capability.v1"),
            ClosedExecutionCapabilityOutcome::Observed,
            BTreeSet::from([requirement_identity]),
            vec![identity("evidence")],
        )
        .unwrap();
        let requirements =
            ClosedExecutionRequirementSet::new(vec![ClosedExecutionRequirement::new(
                mechanism("example.obligation.v1"),
                BTreeMap::new(),
            )
            .unwrap()])
            .unwrap();
        let descriptor = ClosedExecutionProviderDescriptor::new(
            identity("provider"),
            identity("implementation"),
        );
        let challenge = ClosedExecutionProbeChallenge::new(identity("challenge"), 100).unwrap();
        assert_eq!(
            ClosedExecutionProviderCapabilityManifest::new(
                &descriptor,
                &challenge,
                &requirements,
                10,
                20,
                vec![observation.clone(), observation],
            )
            .unwrap_err()
            .code(),
            "closed_execution_provider_capability_duplicate"
        );

        let unrequested = ClosedExecutionCapabilityObservation::new(
            mechanism("example.other_capability.v1"),
            ClosedExecutionCapabilityOutcome::Observed,
            BTreeSet::from([identity("unrequested-requirement")]),
            vec![identity("other-evidence")],
        )
        .unwrap();
        assert_eq!(
            ClosedExecutionProviderCapabilityManifest::new(
                &descriptor,
                &challenge,
                &requirements,
                10,
                20,
                vec![unrequested],
            )
            .unwrap_err()
            .code(),
            "closed_execution_provider_unrequested_requirement_claimed"
        );

        let repeated_obligation = mechanism("example.parameterized_obligation.v1");
        let parameterized = ClosedExecutionRequirementSet::new(vec![
            ClosedExecutionRequirement::new(
                repeated_obligation.clone(),
                BTreeMap::from([("scope".to_string(), "first".to_string())]),
            )
            .unwrap(),
            ClosedExecutionRequirement::new(
                repeated_obligation,
                BTreeMap::from([("scope".to_string(), "second".to_string())]),
            )
            .unwrap(),
        ])
        .unwrap();
        assert_eq!(parameterized.requirements().len(), 2);
        let parameterized_manifest = ClosedExecutionProviderCapabilityManifest::new(
            &descriptor,
            &challenge,
            &parameterized,
            10,
            20,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(parameterized_manifest.blocking_gaps().len(), 2);
        assert_ne!(
            parameterized_manifest.blocking_gaps()[0],
            parameterized_manifest.blocking_gaps()[1]
        );
    }

    #[test]
    fn verifier_rejects_replayed_probe_and_stale_peer_evidence() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect();
        let provider = provider(
            "example.closed_execution.freshness_mechanic.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let first_challenge =
            ClosedExecutionProbeChallenge::new(identity("first-challenge"), 100).unwrap();
        let replay_challenge =
            ClosedExecutionProbeChallenge::new(identity("replay-challenge"), 100).unwrap();
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let verified = verified_provider(&provider, &clock, &evidence_verifier);
        let manifest = verified.probe(&first_challenge, &requirements).unwrap();

        assert_eq!(
            manifest.descriptor_identity(),
            provider.descriptor().descriptor_identity()
        );
        assert_eq!(manifest.challenge_identity(), first_challenge.identity());
        assert_eq!(manifest.requirement_set_identity(), requirements.identity());
        assert_eq!(
            manifest
                .validate_for(provider.descriptor(), &replay_challenge, &requirements)
                .unwrap_err()
                .code(),
            "closed_execution_provider_manifest_binding_invalid"
        );

        let peer = verified.observe_peer(()).unwrap();
        let snapshot = peer.credential_snapshot(&first_challenge).unwrap();
        assert_eq!(
            snapshot
                .validate_for(
                    provider.descriptor().provider_identity(),
                    peer.handle_identity(),
                    &replay_challenge,
                    20,
                    20,
                )
                .unwrap_err()
                .code(),
            "closed_execution_credential_snapshot_binding_invalid"
        );

        let future_snapshot = ClosedExecutionCredentialSnapshot::new(
            provider.descriptor().provider_identity().clone(),
            peer.handle_identity().clone(),
            first_challenge.identity().clone(),
            30,
            vec![ClosedExecutionCredentialClaim::new(
                mechanism("example.identity.claim.v1"),
                identity("future-value"),
                identity("future-evidence"),
            )],
        )
        .unwrap();
        assert_eq!(
            future_snapshot
                .validate_for(
                    provider.descriptor().provider_identity(),
                    peer.handle_identity(),
                    &first_challenge,
                    20,
                    20,
                )
                .unwrap_err()
                .code(),
            "closed_execution_credential_snapshot_binding_invalid"
        );
    }

    #[test]
    fn verifier_rejects_unresolved_evidence_and_record_replay() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect::<BTreeSet<_>>();
        let evidence_provider = provider(
            "example.closed_execution.evidence_mechanic.v1",
            covered.clone(),
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let challenge =
            ClosedExecutionProbeChallenge::new(identity("evidence-challenge"), 100).unwrap();
        let clock = TestClock::default();
        let rejecting_verifier = TestEvidenceVerifier {
            rejected_ref: Some(identity("probe-evidence")),
            ..TestEvidenceVerifier::default()
        };
        let verified = verified_provider(&evidence_provider, &clock, &rejecting_verifier);
        assert_eq!(
            invocation_contract_code(verified.probe(&challenge, &requirements).unwrap_err()),
            "closed_execution_test_evidence_unresolved"
        );

        let mut replaying_provider = provider(
            "example.closed_execution.transcript_mechanic.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        replaying_provider.replay_record_observation = true;
        let accepting_verifier = TestEvidenceVerifier::default();
        let replaying_verified =
            verified_provider(&replaying_provider, &clock, &accepting_verifier);
        let replay_challenge =
            ClosedExecutionProbeChallenge::new(identity("transcript-challenge"), 100).unwrap();
        let (peer, _, _, mut session) = replaying_verified
            .establish_session((), &replay_challenge, &requirements, 100)
            .unwrap();
        replaying_verified
            .send_record(&mut session, &peer, b"same-record")
            .unwrap();
        assert_eq!(
            invocation_contract_code(
                replaying_verified
                    .send_record(&mut session, &peer, b"same-record")
                    .unwrap_err(),
            ),
            "closed_execution_record_transport_binding_invalid"
        );
    }

    #[test]
    fn session_binds_the_exact_provider_implementation() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect::<BTreeSet<_>>();
        let original = provider(
            "example.closed_execution.shared_provider.v1",
            covered.clone(),
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let mut replacement = provider(
            "example.closed_execution.shared_provider.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        replacement.descriptor = ClosedExecutionProviderDescriptor::new(
            original.descriptor.provider_identity().clone(),
            identity("different-implementation-bytes"),
        );
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let original_verified = verified_provider(&original, &clock, &evidence_verifier);
        let challenge =
            ClosedExecutionProbeChallenge::new(identity("implementation-session"), 100).unwrap();
        let (_, _, _, session) = original_verified
            .establish_session((), &challenge, &requirements, 100)
            .unwrap();
        let request = execution_request(&session, "implementation");
        let replacement_verified = verified_provider(&replacement, &clock, &evidence_verifier);
        assert_eq!(
            invocation_contract_code(
                replacement_verified
                    .create_process_set(&session, &request)
                    .unwrap_err(),
            ),
            "closed_execution_session_binding_invalid"
        );

        let alternate_evidence_verifier = TestEvidenceVerifier {
            verifier_identity: identity("alternate-evidence-verifier"),
            ..TestEvidenceVerifier::default()
        };
        let alternate_verified = verified_provider(&original, &clock, &alternate_evidence_verifier);
        assert_eq!(
            invocation_contract_code(
                alternate_verified
                    .create_process_set(&session, &request)
                    .unwrap_err(),
            ),
            "closed_execution_session_binding_invalid"
        );
    }

    #[test]
    fn verifier_rejects_mixed_provider_handles_and_unbound_spawn_evidence() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect::<BTreeSet<_>>();
        let first = provider(
            "example.closed_execution.first_mechanic.v1",
            covered.clone(),
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let second = provider(
            "example.closed_execution.second_mechanic.v1",
            covered.clone(),
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let first_verified = verified_provider(&first, &clock, &evidence_verifier);
        let second_verified = verified_provider(&second, &clock, &evidence_verifier);
        let first_challenge =
            ClosedExecutionProbeChallenge::new(identity("first-session"), 100).unwrap();
        let second_challenge =
            ClosedExecutionProbeChallenge::new(identity("second-session"), 100).unwrap();
        let (_, _, _, first_session) = first_verified
            .establish_session((), &first_challenge, &requirements, 100)
            .unwrap();
        let (_, _, _, second_session) = second_verified
            .establish_session((), &second_challenge, &requirements, 100)
            .unwrap();
        let first_request = execution_request(&first_session, "first");
        let second_request = execution_request(&second_session, "second");
        let second_process_set = second_verified
            .create_process_set(&second_session, &second_request)
            .unwrap();

        assert_eq!(
            invocation_contract_code(
                first_verified
                    .prepare_spawn(&first_session, &first_request, &second_process_set)
                    .unwrap_err(),
            ),
            "closed_execution_provider_handle_binding_invalid"
        );

        let mut forged = provider(
            "example.closed_execution.forged_spawn_mechanic.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        forged.forge_spawn_observation = true;
        let forged_verified = verified_provider(&forged, &clock, &evidence_verifier);
        let forged_challenge =
            ClosedExecutionProbeChallenge::new(identity("forged-session"), 100).unwrap();
        let (_, _, _, forged_session) = forged_verified
            .establish_session((), &forged_challenge, &requirements, 100)
            .unwrap();
        let forged_request = execution_request(&forged_session, "forged");
        let process_set = forged_verified
            .create_process_set(&forged_session, &forged_request)
            .unwrap();
        let plan = forged_verified
            .prepare_spawn(&forged_session, &forged_request, &process_set)
            .unwrap();
        assert_eq!(
            invocation_contract_code(
                forged_verified
                    .spawn(&forged_session, &forged_request, &plan, &process_set,)
                    .unwrap_err(),
            ),
            "closed_execution_spawn_observation_binding_invalid"
        );
    }

    #[test]
    fn verifier_requires_transport_and_lifecycle_completion_before_deadline() {
        let provider_identity = identity("transport-provider");
        let peer_identity = identity("transport-peer");
        let record_context = ClosedExecutionRecordContext::new(
            identity("transport-session"),
            0,
            identity("transport-predecessor"),
            ClosedExecutionRecordDirection::Sent,
            50,
        );
        let observation = ClosedExecutionRecordTransportObservation::new(
            provider_identity.clone(),
            peer_identity.clone(),
            &record_context,
            b"record",
            50,
            vec![identity("transport-evidence")],
        )
        .unwrap();
        assert_eq!(
            observation
                .validate_for(
                    &provider_identity,
                    &peer_identity,
                    &record_context,
                    b"record",
                    20,
                    20,
                )
                .unwrap_err()
                .code(),
            "closed_execution_record_transport_binding_invalid"
        );

        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect();
        let mut provider = provider(
            "example.closed_execution.deadline_mechanic.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        provider.lifecycle_observed_monotonic_ns = 50;
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let verified = verified_provider(&provider, &clock, &evidence_verifier);
        let challenge =
            ClosedExecutionProbeChallenge::new(identity("deadline-session"), 100).unwrap();
        let (_, _, _, session) = verified
            .establish_session((), &challenge, &requirements, 100)
            .unwrap();
        let request = execution_request(&session, "deadline");
        let process_set = verified.create_process_set(&session, &request).unwrap();
        assert_eq!(
            invocation_contract_code(verified.terminate(&session, &process_set).unwrap_err()),
            "closed_execution_lifecycle_observation_binding_invalid"
        );
    }

    #[test]
    fn verifier_consumes_challenges_once_and_separates_trust_roles() {
        let requirements = requirements();
        let covered = requirements
            .requirements()
            .iter()
            .map(|requirement| requirement.requirement_identity().clone())
            .collect();
        let provider = provider(
            "example.closed_execution.role_separation_mechanic.v1",
            covered,
            ClosedExecutionCapabilityOutcome::Observed,
        );
        let clock = TestClock::default();
        let evidence_verifier = TestEvidenceVerifier::default();
        let verified = verified_provider(&provider, &clock, &evidence_verifier);
        let challenge =
            ClosedExecutionProbeChallenge::new(identity("one-time-session"), 100).unwrap();
        verified
            .establish_session((), &challenge, &requirements, 100)
            .unwrap();
        assert_eq!(
            invocation_contract_code(
                verified
                    .establish_session((), &challenge, &requirements, 100)
                    .unwrap_err(),
            ),
            "closed_execution_challenge_replayed"
        );

        let colliding_clock = TestClock {
            clock_identity: provider.descriptor().provider_identity().clone(),
            verification_authority_identity: identity("test-verification-authority"),
        };
        assert_eq!(
            VerifiedClosedExecutionProvider::try_new(
                &provider,
                &colliding_clock,
                &evidence_verifier,
            )
            .unwrap_err()
            .code(),
            "closed_execution_verification_roles_not_independent"
        );

        let mismatched_verifier = TestEvidenceVerifier {
            bound_clock_identity: identity("different-verifier-clock"),
            ..TestEvidenceVerifier::default()
        };
        assert_eq!(
            VerifiedClosedExecutionProvider::try_new(&provider, &clock, &mismatched_verifier)
                .unwrap_err()
                .code(),
            "closed_execution_verification_roles_not_independent"
        );
    }
}
