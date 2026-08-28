use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub mod transport_access_unit_observation;
pub use transport_access_unit_observation::{
    TransportAccessUnitFragment, TransportAccessUnitObservation,
    TransportAccessUnitObservationInput,
    TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION_VERSION,
    TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA_VERSION,
};

pub const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_receipt.v2";
pub const RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1";
pub const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM: &str = "ed25519";
pub const RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL: &str = "gpu-hmr-evidence-transport";
pub const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2";
pub const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE: &str = "gpu_hmr_observed_runtime_evidence";
pub const OBSERVED_RUNTIME_EVIDENCE_AUTHORITY: &str =
    "worker_signed_observation_transport_only_not_gpu_hmr_acceptance";
pub const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.observed_runtime_evidence_delivery.v1";
pub const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE: &str =
    "gpu_hmr_observed_runtime_evidence_delivery";
pub const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_ENCODING: &str = "base64url_no_pad";
pub const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY: &str =
    "worker_payload_delivery_only_not_gpu_hmr_acceptance";
const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER: &str = "synthi-webrtc-compiler-worker";
const KEY_ID_PREFIX: &str = "gpu-hmr-runtime-evidence-transport-key:sha256:";
const RECEIPT_ID_PREFIX: &str = "gpu-hmr-runtime-evidence-transport-receipt:sha256:";
const KEY_ANNOUNCEMENT_ID_PREFIX: &str =
    "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const WORKER_INSTANCE_ID_PREFIX: &str = "gpu-hmr-worker-instance:sha256:";
const SIGNATURE_PREFIX: &str = "ed25519:";
const OBSERVATION_CONTEXT_DOMAIN: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_observation_context.v1";
const SUBJECT_IDENTITY_DOMAIN: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_subject_identity.v1";
const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES: u64 = 512 * 1024;
const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_SERIALIZED_BYTES: usize =
    (OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES as usize) * 2;
const MAX_RECEIPT_AGE: Duration = Duration::from_secs(300);
const MAX_FUTURE_SKEW: Duration = Duration::from_secs(30);

static GLOBAL_TRANSPORT_SIGNER: OnceLock<Result<RuntimeEvidenceTransportSigner, String>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub struct RuntimeEvidenceTransportReceiptInput<'a> {
    pub runner_process_id: u32,
    pub runtime_session_id: &'a str,
    pub runner_challenge: &'a str,
    pub transport_session_id: &'a str,
    pub request_id: &'a str,
    pub source_edit_id: &'a str,
    pub subject_identity_namespace: &'a str,
    pub subject_canonical_bytes: &'a [u8],
    pub artifact_content_hash: &'a str,
    pub observed_runtime_proof_id: &'a str,
    pub observed_proof_ledger_id: &'a str,
    pub observed_payload: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeEvidenceTransportVerificationContext<'a> {
    pub worker_instance_id: &'a str,
    pub worker_process_id: u32,
    pub runner_process_id: u32,
    pub runtime_session_id: &'a str,
    pub runner_challenge: &'a str,
    pub transport_session_id: &'a str,
    pub request_id: &'a str,
    pub source_edit_id: &'a str,
    pub subject_identity_namespace: &'a str,
    pub subject_canonical_bytes: &'a [u8],
    pub artifact_content_hash: &'a str,
    pub observed_runtime_proof_id: &'a str,
    pub observed_proof_ledger_id: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeEvidenceTransportFreshnessPolicy {
    max_receipt_age_ns: u128,
    max_future_skew_ns: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEvidenceTransportWorkerPin {
    key_id: String,
    worker_instance_id: String,
    worker_process_id: String,
    key_announcement_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidenceTransportVerificationKey {
    schema_version: String,
    algorithm: String,
    key_id: String,
    producer: String,
    worker_instance_id: String,
    worker_process_id: String,
    public_key: String,
    key_announcement_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidenceTransportReceipt {
    schema_version: String,
    algorithm: String,
    key_id: String,
    producer: String,
    worker_instance_id: String,
    worker_process_id: String,
    runner_process_id: String,
    runtime_session_id: String,
    runner_challenge_sha256: String,
    transport_session_binding_sha256: String,
    request_id: String,
    source_edit_id: String,
    subject_identity_namespace: String,
    subject_identity_hash: String,
    artifact_content_hash: String,
    observed_runtime_proof_id: String,
    observed_proof_ledger_id: String,
    observed_payload_sha256: String,
    observation_context_hash: String,
    issued_at_unix_ns: String,
    sequence: String,
    nonce: String,
    receipt_id: String,
    signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedRuntimeEvidenceEnvelope {
    schema_version: String,
    #[serde(rename = "type")]
    message_type: String,
    observed_payload_sha256: String,
    runtime_evidence_transport_receipt: RuntimeEvidenceTransportReceipt,
    proof_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedRuntimeEvidenceDelivery {
    schema_version: String,
    #[serde(rename = "type")]
    message_type: String,
    observed_payload_encoding: String,
    observed_payload_byte_length: String,
    observed_payload_base64: String,
    runtime_evidence_transport_envelope: ObservedRuntimeEvidenceEnvelope,
    proof_authority: String,
    accepted_for_gpu_hmr: bool,
    gpu_hmr_success: bool,
    can_satisfy_runtime_proof: bool,
}

#[derive(Clone)]
pub struct RuntimeEvidenceTransportSigner {
    key_pair: Arc<Ed25519KeyPair>,
    verification_key: RuntimeEvidenceTransportVerificationKey,
    sequence: Arc<AtomicU64>,
}

pub struct RuntimeEvidenceTransportReceiptConsumer {
    verification_key: RuntimeEvidenceTransportVerificationKey,
    freshness_policy: RuntimeEvidenceTransportFreshnessPolicy,
    replay_store: Arc<dyn RuntimeEvidenceTransportReplayStore>,
    clock: Arc<dyn Fn() -> Result<u128, String> + Send + Sync>,
}

/// Production implementations must persist state across consumer recreation
/// for the lifetime of the pinned worker key and transport session.
pub trait RuntimeEvidenceTransportReplayStore: Send + Sync {
    /// Atomically rejects a receipt at or below the persisted sequence floor,
    /// then advances the floor and consumes the receipt ID on success.
    fn consume_if_newer(
        &self,
        key_id: &str,
        worker_instance_id: &str,
        transport_session_binding_sha256: &str,
        sequence: u64,
        receipt_id: &str,
    ) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use]
pub struct RuntimeEvidenceTransportSupportOnlyConsumption {
    receipt_id: String,
    observation_context_hash: String,
}

#[derive(Clone, Copy)]
struct ObservationContextMaterial<'a> {
    key_id: &'a str,
    worker_instance_id: &'a str,
    worker_process_id: &'a str,
    runner_process_id: &'a str,
    runtime_session_id: &'a str,
    runner_challenge_sha256: &'a str,
    transport_session_binding_sha256: &'a str,
    request_id: &'a str,
    source_edit_id: &'a str,
    subject_identity_namespace: &'a str,
    subject_identity_hash: &'a str,
    artifact_content_hash: &'a str,
    observed_runtime_proof_id: &'a str,
    observed_proof_ledger_id: &'a str,
    observed_payload_sha256: &'a str,
}

impl std::fmt::Debug for RuntimeEvidenceTransportSigner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeEvidenceTransportSigner")
            .field("key_id", &self.verification_key.key_id)
            .field(
                "worker_instance_id",
                &self.verification_key.worker_instance_id,
            )
            .field(
                "worker_process_id",
                &self.verification_key.worker_process_id,
            )
            .finish_non_exhaustive()
    }
}

impl RuntimeEvidenceTransportSigner {
    pub fn generate(worker_process_id: u32) -> Result<Self, String> {
        if worker_process_id == 0 {
            return Err("runtime_evidence_transport_worker_process_id_invalid".to_string());
        }
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| "runtime_evidence_transport_key_generation_failed".to_string())?;
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| "runtime_evidence_transport_key_parse_failed".to_string())?;
        Self::from_key_pair(key_pair, worker_process_id)
    }

    fn from_key_pair(key_pair: Ed25519KeyPair, worker_process_id: u32) -> Result<Self, String> {
        if worker_process_id == 0 {
            return Err("runtime_evidence_transport_worker_process_id_invalid".to_string());
        }
        let public_key = key_pair.public_key().as_ref();
        let key_id = format!("{KEY_ID_PREFIX}{}", sha256_hex(public_key));
        let worker_instance_id = format!("{WORKER_INSTANCE_ID_PREFIX}{}", random_hex_32());
        let public_key = URL_SAFE_NO_PAD.encode(public_key);
        let worker_process_id = worker_process_id.to_string();
        let announcement_material = json!([
            RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA_VERSION,
            RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM,
            key_id,
            RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER,
            worker_instance_id,
            worker_process_id,
            public_key,
        ]);
        let announcement_bytes = serde_json::to_vec(&announcement_material).map_err(|error| {
            format!("runtime_evidence_transport_key_announcement_serialize_failed:{error}")
        })?;
        let verification_key = RuntimeEvidenceTransportVerificationKey {
            schema_version: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA_VERSION.to_string(),
            algorithm: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM.to_string(),
            key_id,
            producer: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER.to_string(),
            worker_instance_id,
            worker_process_id,
            public_key,
            key_announcement_id: format!(
                "{KEY_ANNOUNCEMENT_ID_PREFIX}{}",
                sha256_hex(&announcement_bytes)
            ),
        };
        verification_key.validate_shape()?;
        Ok(Self {
            key_pair: Arc::new(key_pair),
            verification_key,
            sequence: Arc::new(AtomicU64::new(0)),
        })
    }

    pub fn verification_key(&self) -> &RuntimeEvidenceTransportVerificationKey {
        &self.verification_key
    }

    pub fn issue(
        &self,
        input: RuntimeEvidenceTransportReceiptInput<'_>,
    ) -> Result<RuntimeEvidenceTransportReceipt, String> {
        validate_input(&input)?;
        let issued_at_unix_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "runtime_evidence_transport_clock_before_epoch".to_string())?
            .as_nanos()
            .to_string();
        let sequence = self
            .sequence
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current.checked_add(1)
            })
            .map_err(|_| "runtime_evidence_transport_sequence_exhausted".to_string())?
            + 1;
        self.issue_at(
            input,
            issued_at_unix_ns,
            sequence.to_string(),
            random_hex_32(),
        )
    }

    fn issue_at(
        &self,
        input: RuntimeEvidenceTransportReceiptInput<'_>,
        issued_at_unix_ns: String,
        sequence: String,
        nonce: String,
    ) -> Result<RuntimeEvidenceTransportReceipt, String> {
        validate_input(&input)?;
        if !canonical_u128(&issued_at_unix_ns) {
            return Err("runtime_evidence_transport_issued_at_invalid".to_string());
        }
        if !canonical_u64(&sequence) {
            return Err("runtime_evidence_transport_sequence_invalid".to_string());
        }
        if !canonical_hex(&nonce, 64) {
            return Err("runtime_evidence_transport_nonce_invalid".to_string());
        }

        let runner_process_id = input.runner_process_id.to_string();
        let runner_challenge_sha256 = prefixed_sha256(input.runner_challenge.as_bytes());
        let transport_session_binding_sha256 =
            transport_session_binding(input.transport_session_id);
        let subject_identity_hash = subject_identity_hash(
            input.subject_identity_namespace,
            input.subject_canonical_bytes,
        )?;
        let observed_payload_sha256 = prefixed_sha256(input.observed_payload);
        let observation_context_hash = observation_context_hash(ObservationContextMaterial {
            key_id: &self.verification_key.key_id,
            worker_instance_id: &self.verification_key.worker_instance_id,
            worker_process_id: &self.verification_key.worker_process_id,
            runner_process_id: &runner_process_id,
            runtime_session_id: input.runtime_session_id,
            runner_challenge_sha256: &runner_challenge_sha256,
            transport_session_binding_sha256: &transport_session_binding_sha256,
            request_id: input.request_id,
            source_edit_id: input.source_edit_id,
            subject_identity_namespace: input.subject_identity_namespace,
            subject_identity_hash: &subject_identity_hash,
            artifact_content_hash: input.artifact_content_hash,
            observed_runtime_proof_id: input.observed_runtime_proof_id,
            observed_proof_ledger_id: input.observed_proof_ledger_id,
            observed_payload_sha256: &observed_payload_sha256,
        })?;
        let mut receipt = RuntimeEvidenceTransportReceipt {
            schema_version: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION.to_string(),
            algorithm: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM.to_string(),
            key_id: self.verification_key.key_id.clone(),
            producer: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER.to_string(),
            worker_instance_id: self.verification_key.worker_instance_id.clone(),
            worker_process_id: self.verification_key.worker_process_id.clone(),
            runner_process_id,
            runtime_session_id: input.runtime_session_id.to_string(),
            runner_challenge_sha256,
            transport_session_binding_sha256,
            request_id: input.request_id.to_string(),
            source_edit_id: input.source_edit_id.to_string(),
            subject_identity_namespace: input.subject_identity_namespace.to_string(),
            subject_identity_hash,
            artifact_content_hash: input.artifact_content_hash.to_string(),
            observed_runtime_proof_id: input.observed_runtime_proof_id.to_string(),
            observed_proof_ledger_id: input.observed_proof_ledger_id.to_string(),
            observed_payload_sha256,
            observation_context_hash,
            issued_at_unix_ns,
            sequence,
            nonce,
            receipt_id: String::new(),
            signature: String::new(),
        };
        let signing_bytes = receipt.signing_bytes()?;
        receipt.receipt_id = format!("{RECEIPT_ID_PREFIX}{}", sha256_hex(&signing_bytes));
        receipt.signature = format!(
            "{SIGNATURE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(self.key_pair.sign(&signing_bytes).as_ref())
        );
        Ok(receipt)
    }
}

impl RuntimeEvidenceTransportVerificationKey {
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn worker_instance_id(&self) -> &str {
        &self.worker_instance_id
    }

    pub fn worker_process_id(&self) -> Result<u32, String> {
        self.worker_process_id
            .parse::<u32>()
            .map_err(|_| "runtime_evidence_transport_worker_process_id_invalid".to_string())
    }

    pub fn key_announcement_id(&self) -> &str {
        &self.key_announcement_id
    }

    fn material_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&json!([
            self.schema_version,
            self.algorithm,
            self.key_id,
            self.producer,
            self.worker_instance_id,
            self.worker_process_id,
            self.public_key,
        ]))
        .map_err(|error| {
            format!("runtime_evidence_transport_key_material_serialize_failed:{error}")
        })
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.schema_version != RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA_VERSION
            || self.algorithm != RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM
            || self.producer != RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER
            || !canonical_prefixed_sha256(&self.key_id, KEY_ID_PREFIX)
            || !canonical_prefixed_sha256(&self.worker_instance_id, WORKER_INSTANCE_ID_PREFIX)
            || !canonical_u32(&self.worker_process_id)
            || !canonical_prefixed_sha256(&self.key_announcement_id, KEY_ANNOUNCEMENT_ID_PREFIX)
        {
            return Err("runtime_evidence_transport_verification_key_shape_invalid".to_string());
        }
        let public_key = URL_SAFE_NO_PAD.decode(&self.public_key).map_err(|_| {
            "runtime_evidence_transport_verification_key_encoding_invalid".to_string()
        })?;
        if public_key.len() != 32
            || URL_SAFE_NO_PAD.encode(&public_key) != self.public_key
            || self.key_id != format!("{KEY_ID_PREFIX}{}", sha256_hex(&public_key))
            || self.key_announcement_id
                != format!(
                    "{KEY_ANNOUNCEMENT_ID_PREFIX}{}",
                    sha256_hex(&self.material_bytes()?)
                )
        {
            return Err(
                "runtime_evidence_transport_verification_key_identity_mismatch".to_string(),
            );
        }
        Ok(())
    }

    fn public_key_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate_shape()?;
        URL_SAFE_NO_PAD
            .decode(&self.public_key)
            .map_err(|_| "runtime_evidence_transport_verification_key_encoding_invalid".to_string())
    }
}

impl RuntimeEvidenceTransportReceipt {
    fn signing_bytes(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&json!([
            self.schema_version,
            self.algorithm,
            self.key_id,
            self.producer,
            self.worker_instance_id,
            self.worker_process_id,
            self.runner_process_id,
            self.runtime_session_id,
            self.runner_challenge_sha256,
            self.transport_session_binding_sha256,
            self.request_id,
            self.source_edit_id,
            self.subject_identity_namespace,
            self.subject_identity_hash,
            self.artifact_content_hash,
            self.observed_runtime_proof_id,
            self.observed_proof_ledger_id,
            self.observed_payload_sha256,
            self.observation_context_hash,
            self.issued_at_unix_ns,
            self.sequence,
            self.nonce,
        ]))
        .map_err(|error| {
            format!("runtime_evidence_transport_receipt_material_serialize_failed:{error}")
        })
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.schema_version != RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION
            || self.algorithm != RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM
            || self.producer != RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER
            || !canonical_prefixed_sha256(&self.key_id, KEY_ID_PREFIX)
            || !canonical_prefixed_sha256(&self.worker_instance_id, WORKER_INSTANCE_ID_PREFIX)
            || !canonical_u32(&self.worker_process_id)
            || !canonical_u32(&self.runner_process_id)
            || !canonical_token(&self.runtime_session_id)
            || !canonical_sha256(&self.runner_challenge_sha256)
            || !canonical_sha256(&self.transport_session_binding_sha256)
            || !canonical_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
            || !canonical_token(&self.subject_identity_namespace)
            || !canonical_sha256(&self.subject_identity_hash)
            || !canonical_sha256(&self.artifact_content_hash)
            || !canonical_runtime_proof_id(&self.observed_runtime_proof_id)
            || !canonical_ledger_proof_id(&self.observed_proof_ledger_id)
            || !canonical_sha256(&self.observed_payload_sha256)
            || !canonical_sha256(&self.observation_context_hash)
            || !canonical_u128(&self.issued_at_unix_ns)
            || !canonical_u64(&self.sequence)
            || !canonical_hex(&self.nonce, 64)
            || !canonical_prefixed_sha256(&self.receipt_id, RECEIPT_ID_PREFIX)
            || !self
                .signature
                .strip_prefix(SIGNATURE_PREFIX)
                .is_some_and(|value| canonical_base64url(value, 64))
        {
            return Err("runtime_evidence_transport_receipt_field_shape_invalid".to_string());
        }
        if self.observation_context_hash != observation_context_hash(self.context_material())? {
            return Err("runtime_evidence_transport_observation_context_hash_mismatch".to_string());
        }
        Ok(())
    }

    fn context_material(&self) -> ObservationContextMaterial<'_> {
        ObservationContextMaterial {
            key_id: &self.key_id,
            worker_instance_id: &self.worker_instance_id,
            worker_process_id: &self.worker_process_id,
            runner_process_id: &self.runner_process_id,
            runtime_session_id: &self.runtime_session_id,
            runner_challenge_sha256: &self.runner_challenge_sha256,
            transport_session_binding_sha256: &self.transport_session_binding_sha256,
            request_id: &self.request_id,
            source_edit_id: &self.source_edit_id,
            subject_identity_namespace: &self.subject_identity_namespace,
            subject_identity_hash: &self.subject_identity_hash,
            artifact_content_hash: &self.artifact_content_hash,
            observed_runtime_proof_id: &self.observed_runtime_proof_id,
            observed_proof_ledger_id: &self.observed_proof_ledger_id,
            observed_payload_sha256: &self.observed_payload_sha256,
        }
    }
}

impl RuntimeEvidenceTransportFreshnessPolicy {
    pub fn new(max_receipt_age: Duration, max_future_skew: Duration) -> Result<Self, String> {
        if max_receipt_age.is_zero()
            || max_receipt_age > MAX_RECEIPT_AGE
            || max_future_skew > MAX_FUTURE_SKEW
        {
            return Err("runtime_evidence_transport_freshness_policy_invalid".to_string());
        }
        Ok(Self {
            max_receipt_age_ns: max_receipt_age.as_nanos(),
            max_future_skew_ns: max_future_skew.as_nanos(),
        })
    }
}

impl RuntimeEvidenceTransportWorkerPin {
    /// The caller must source these values from an authenticated control-plane
    /// key announcement, never from the receipt or observed payload.
    pub fn from_authenticated_control_plane(
        key_id: &str,
        worker_instance_id: &str,
        worker_process_id: u32,
        key_announcement_id: &str,
    ) -> Result<Self, String> {
        let worker_process_id = worker_process_id.to_string();
        if !canonical_prefixed_sha256(key_id, KEY_ID_PREFIX)
            || !canonical_prefixed_sha256(worker_instance_id, WORKER_INSTANCE_ID_PREFIX)
            || !canonical_u32(&worker_process_id)
            || !canonical_prefixed_sha256(key_announcement_id, KEY_ANNOUNCEMENT_ID_PREFIX)
        {
            return Err("runtime_evidence_transport_worker_pin_invalid".to_string());
        }
        Ok(Self {
            key_id: key_id.to_string(),
            worker_instance_id: worker_instance_id.to_string(),
            worker_process_id,
            key_announcement_id: key_announcement_id.to_string(),
        })
    }
}

impl RuntimeEvidenceTransportReceiptConsumer {
    pub fn new(
        verification_key: RuntimeEvidenceTransportVerificationKey,
        trusted_worker_pin: RuntimeEvidenceTransportWorkerPin,
        freshness_policy: RuntimeEvidenceTransportFreshnessPolicy,
        replay_store: Arc<dyn RuntimeEvidenceTransportReplayStore>,
    ) -> Result<Self, String> {
        Self::new_with_clock(
            verification_key,
            trusted_worker_pin,
            freshness_policy,
            replay_store,
            Arc::new(system_time_unix_ns),
        )
    }

    fn new_with_clock(
        verification_key: RuntimeEvidenceTransportVerificationKey,
        trusted_worker_pin: RuntimeEvidenceTransportWorkerPin,
        freshness_policy: RuntimeEvidenceTransportFreshnessPolicy,
        replay_store: Arc<dyn RuntimeEvidenceTransportReplayStore>,
        clock: Arc<dyn Fn() -> Result<u128, String> + Send + Sync>,
    ) -> Result<Self, String> {
        verification_key.validate_shape()?;
        if verification_key.key_id != trusted_worker_pin.key_id
            || verification_key.worker_instance_id != trusted_worker_pin.worker_instance_id
            || verification_key.worker_process_id != trusted_worker_pin.worker_process_id
            || verification_key.key_announcement_id != trusted_worker_pin.key_announcement_id
        {
            return Err("runtime_evidence_transport_worker_pin_mismatch".to_string());
        }
        Ok(Self {
            verification_key,
            freshness_policy,
            replay_store,
            clock,
        })
    }

    /// Verifies and atomically consumes a complete support-only envelope.
    /// Success cannot satisfy GPU HMR runtime, dispatch, output, or acceptance proof.
    pub fn consume_support_envelope(
        &self,
        envelope: &ObservedRuntimeEvidenceEnvelope,
        observed_payload: &[u8],
        context: RuntimeEvidenceTransportVerificationContext<'_>,
    ) -> Result<RuntimeEvidenceTransportSupportOnlyConsumption, String> {
        envelope.validate_shape()?;
        let observed_payload_sha256 = prefixed_sha256(observed_payload);
        if envelope.observed_payload_sha256 != observed_payload_sha256 {
            return Err("runtime_evidence_transport_observed_payload_hash_mismatch".to_string());
        }
        let receipt = &envelope.runtime_evidence_transport_receipt;
        verify_runtime_evidence_transport_receipt_signature(receipt, &self.verification_key)?;
        validate_verification_context(&context)?;

        let worker_process_id = context.worker_process_id.to_string();
        let runner_process_id = context.runner_process_id.to_string();
        let runner_challenge_sha256 = prefixed_sha256(context.runner_challenge.as_bytes());
        let transport_session_binding_sha256 =
            transport_session_binding(context.transport_session_id);
        let subject_identity_hash = subject_identity_hash(
            context.subject_identity_namespace,
            context.subject_canonical_bytes,
        )?;
        if self.verification_key.worker_instance_id != context.worker_instance_id
            || self.verification_key.worker_process_id != worker_process_id
            || receipt.worker_instance_id != context.worker_instance_id
            || receipt.worker_process_id != worker_process_id
            || receipt.runner_process_id != runner_process_id
            || receipt.runtime_session_id != context.runtime_session_id
            || receipt.runner_challenge_sha256 != runner_challenge_sha256
            || receipt.transport_session_binding_sha256 != transport_session_binding_sha256
            || receipt.request_id != context.request_id
            || receipt.source_edit_id != context.source_edit_id
            || receipt.subject_identity_namespace != context.subject_identity_namespace
            || receipt.subject_identity_hash != subject_identity_hash
            || receipt.artifact_content_hash != context.artifact_content_hash
            || receipt.observed_runtime_proof_id != context.observed_runtime_proof_id
            || receipt.observed_proof_ledger_id != context.observed_proof_ledger_id
            || receipt.observed_payload_sha256 != observed_payload_sha256
        {
            return Err("runtime_evidence_transport_verification_context_mismatch".to_string());
        }

        let expected_context_hash = observation_context_hash(ObservationContextMaterial {
            key_id: &self.verification_key.key_id,
            worker_instance_id: context.worker_instance_id,
            worker_process_id: &worker_process_id,
            runner_process_id: &runner_process_id,
            runtime_session_id: context.runtime_session_id,
            runner_challenge_sha256: &runner_challenge_sha256,
            transport_session_binding_sha256: &transport_session_binding_sha256,
            request_id: context.request_id,
            source_edit_id: context.source_edit_id,
            subject_identity_namespace: context.subject_identity_namespace,
            subject_identity_hash: &subject_identity_hash,
            artifact_content_hash: context.artifact_content_hash,
            observed_runtime_proof_id: context.observed_runtime_proof_id,
            observed_proof_ledger_id: context.observed_proof_ledger_id,
            observed_payload_sha256: &observed_payload_sha256,
        })?;
        if receipt.observation_context_hash != expected_context_hash {
            return Err(
                "runtime_evidence_transport_verification_context_hash_mismatch".to_string(),
            );
        }

        let now_unix_ns = (self.clock)()?;
        let issued_at_unix_ns = receipt
            .issued_at_unix_ns
            .parse::<u128>()
            .map_err(|_| "runtime_evidence_transport_issued_at_invalid".to_string())?;
        if issued_at_unix_ns > now_unix_ns.saturating_add(self.freshness_policy.max_future_skew_ns)
        {
            return Err("runtime_evidence_transport_receipt_from_future".to_string());
        }
        if issued_at_unix_ns <= now_unix_ns
            && now_unix_ns - issued_at_unix_ns > self.freshness_policy.max_receipt_age_ns
        {
            return Err("runtime_evidence_transport_receipt_expired".to_string());
        }

        let sequence = receipt
            .sequence
            .parse::<u64>()
            .map_err(|_| "runtime_evidence_transport_sequence_invalid".to_string())?;
        self.replay_store.consume_if_newer(
            &receipt.key_id,
            &receipt.worker_instance_id,
            &receipt.transport_session_binding_sha256,
            sequence,
            &receipt.receipt_id,
        )?;

        Ok(RuntimeEvidenceTransportSupportOnlyConsumption {
            receipt_id: receipt.receipt_id.clone(),
            observation_context_hash: receipt.observation_context_hash.clone(),
        })
    }
}

impl RuntimeEvidenceTransportSupportOnlyConsumption {
    pub fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub fn observation_context_hash(&self) -> &str {
        &self.observation_context_hash
    }

    pub fn accepted_for_gpu_hmr(&self) -> bool {
        false
    }

    pub fn gpu_hmr_success(&self) -> bool {
        false
    }

    pub fn can_satisfy_runtime_proof(&self) -> bool {
        false
    }
}

impl ObservedRuntimeEvidenceEnvelope {
    pub fn new(
        observed_payload: &[u8],
        runtime_evidence_transport_receipt: RuntimeEvidenceTransportReceipt,
    ) -> Result<Self, String> {
        let observed_payload_sha256 = prefixed_sha256(observed_payload);
        if runtime_evidence_transport_receipt.observed_payload_sha256 != observed_payload_sha256 {
            return Err("observed_runtime_evidence_payload_receipt_hash_mismatch".to_string());
        }
        let envelope = Self {
            schema_version: OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA_VERSION.to_string(),
            message_type: OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE.to_string(),
            observed_payload_sha256,
            runtime_evidence_transport_receipt,
            proof_authority: OBSERVED_RUNTIME_EVIDENCE_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
        };
        envelope.validate_shape()?;
        Ok(envelope)
    }

    fn validate_shape(&self) -> Result<(), String> {
        if self.schema_version != OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA_VERSION
            || self.message_type != OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE
            || !canonical_sha256(&self.observed_payload_sha256)
            || self.proof_authority != OBSERVED_RUNTIME_EVIDENCE_AUTHORITY
            || self.accepted_for_gpu_hmr
            || self.gpu_hmr_success
            || self.can_satisfy_runtime_proof
        {
            return Err("observed_runtime_evidence_envelope_shape_invalid".to_string());
        }
        self.runtime_evidence_transport_receipt.validate_shape()?;
        if self
            .runtime_evidence_transport_receipt
            .observed_payload_sha256
            != self.observed_payload_sha256
        {
            return Err("observed_runtime_evidence_payload_receipt_hash_mismatch".to_string());
        }
        Ok(())
    }
}

impl ObservedRuntimeEvidenceDelivery {
    pub fn new(
        observed_payload: &[u8],
        runtime_evidence_transport_envelope: ObservedRuntimeEvidenceEnvelope,
    ) -> Result<Self, String> {
        runtime_evidence_transport_envelope.validate_shape()?;
        if observed_payload.is_empty() {
            return Err("observed_runtime_evidence_delivery_payload_empty".to_string());
        }
        let observed_payload_byte_length = u64::try_from(observed_payload.len())
            .map_err(|_| "observed_runtime_evidence_delivery_payload_too_large".to_string())?;
        if observed_payload_byte_length > OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES {
            return Err("observed_runtime_evidence_delivery_payload_too_large".to_string());
        }
        let observed_payload_sha256 = prefixed_sha256(observed_payload);
        if runtime_evidence_transport_envelope.observed_payload_sha256 != observed_payload_sha256 {
            return Err(
                "observed_runtime_evidence_delivery_payload_envelope_hash_mismatch".to_string(),
            );
        }
        Ok(Self {
            schema_version: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA_VERSION.to_string(),
            message_type: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE.to_string(),
            observed_payload_encoding: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_ENCODING.to_string(),
            observed_payload_byte_length: observed_payload_byte_length.to_string(),
            observed_payload_base64: URL_SAFE_NO_PAD.encode(observed_payload),
            runtime_evidence_transport_envelope,
            proof_authority: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY.to_string(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            can_satisfy_runtime_proof: false,
        })
    }

    fn decode_payload_and_validate(&self) -> Result<Vec<u8>, String> {
        if self.schema_version != OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA_VERSION
            || self.message_type != OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE
            || self.observed_payload_encoding != OBSERVED_RUNTIME_EVIDENCE_DELIVERY_ENCODING
            || !canonical_u64(&self.observed_payload_byte_length)
            || self.proof_authority != OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY
            || self.accepted_for_gpu_hmr
            || self.gpu_hmr_success
            || self.can_satisfy_runtime_proof
        {
            return Err("observed_runtime_evidence_delivery_shape_invalid".to_string());
        }
        self.runtime_evidence_transport_envelope.validate_shape()?;
        let observed_payload_byte_length = self
            .observed_payload_byte_length
            .parse::<u64>()
            .map_err(|_| "observed_runtime_evidence_delivery_shape_invalid".to_string())?;
        if observed_payload_byte_length > OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES {
            return Err("observed_runtime_evidence_delivery_payload_too_large".to_string());
        }
        let expected_encoded_length =
            base64url_no_pad_encoded_length(observed_payload_byte_length)?;
        if u64::try_from(self.observed_payload_base64.len()).map_err(|_| {
            "observed_runtime_evidence_delivery_payload_encoding_invalid".to_string()
        })? != expected_encoded_length
        {
            return Err("observed_runtime_evidence_delivery_payload_encoding_invalid".to_string());
        }
        let observed_payload = URL_SAFE_NO_PAD
            .decode(&self.observed_payload_base64)
            .map_err(|_| {
                "observed_runtime_evidence_delivery_payload_encoding_invalid".to_string()
            })?;
        if URL_SAFE_NO_PAD.encode(&observed_payload) != self.observed_payload_base64
            || u64::try_from(observed_payload.len())
                .map_err(|_| "observed_runtime_evidence_delivery_payload_too_large".to_string())?
                != observed_payload_byte_length
        {
            return Err("observed_runtime_evidence_delivery_payload_encoding_invalid".to_string());
        }
        let observed_payload_sha256 = prefixed_sha256(&observed_payload);
        if observed_payload_sha256
            != self
                .runtime_evidence_transport_envelope
                .observed_payload_sha256
        {
            return Err(
                "observed_runtime_evidence_delivery_payload_envelope_hash_mismatch".to_string(),
            );
        }
        Ok(observed_payload)
    }

    fn validate_shape(&self) -> Result<(), String> {
        self.decode_payload_and_validate().map(|_| ())
    }

    pub fn serialize_for_transport(&self) -> Result<String, String> {
        self.validate_shape()?;
        let serialized = serde_json::to_string(self)
            .map_err(|_| "observed_runtime_evidence_delivery_serialize_failed".to_string())?;
        if serialized.len() > OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_SERIALIZED_BYTES {
            return Err(
                "observed_runtime_evidence_delivery_serialized_payload_too_large".to_string(),
            );
        }
        Ok(serialized)
    }
}

fn base64url_no_pad_encoded_length(byte_length: u64) -> Result<u64, String> {
    let full_groups = byte_length / 3;
    let remainder = byte_length % 3;
    full_groups
        .checked_mul(4)
        .and_then(|length| {
            length.checked_add(match remainder {
                0 => 0,
                1 => 2,
                2 => 3,
                _ => unreachable!(),
            })
        })
        .ok_or_else(|| "observed_runtime_evidence_delivery_payload_too_large".to_string())
}

pub fn initialize_runtime_evidence_transport_signer() -> Result<(), String> {
    let signer = harden_runtime_evidence_transport_signer_process()
        .and_then(|_| RuntimeEvidenceTransportSigner::generate(std::process::id()));
    let result = signer.as_ref().map(|_| ()).map_err(Clone::clone);
    GLOBAL_TRANSPORT_SIGNER
        .set(signer)
        .map_err(|_| "runtime_evidence_transport_signer_already_initialized".to_string())?;
    result
}

fn harden_runtime_evidence_transport_signer_process() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // The runner executes user-owned code in a child process. Keep the
        // parent-only ephemeral signing key out of ptrace and /proc memory
        // access available to same-UID descendants.
        let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if result != 0 {
            return Err(format!(
                "runtime_evidence_transport_process_hardening_failed:{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

pub fn global_runtime_evidence_transport_signer(
) -> Result<&'static RuntimeEvidenceTransportSigner, String> {
    GLOBAL_TRANSPORT_SIGNER
        .get()
        .ok_or_else(|| "runtime_evidence_transport_signer_not_initialized".to_string())?
        .as_ref()
        .map_err(Clone::clone)
}

fn verify_runtime_evidence_transport_receipt_signature(
    receipt: &RuntimeEvidenceTransportReceipt,
    verification_key: &RuntimeEvidenceTransportVerificationKey,
) -> Result<(), String> {
    receipt.validate_shape()?;
    verification_key.validate_shape()?;
    if receipt.key_id != verification_key.key_id
        || receipt.worker_instance_id != verification_key.worker_instance_id
        || receipt.worker_process_id != verification_key.worker_process_id
    {
        return Err("runtime_evidence_transport_signer_identity_mismatch".to_string());
    }
    let signing_bytes = receipt.signing_bytes()?;
    if receipt.receipt_id != format!("{RECEIPT_ID_PREFIX}{}", sha256_hex(&signing_bytes)) {
        return Err("runtime_evidence_transport_receipt_id_mismatch".to_string());
    }
    let signature = receipt
        .signature
        .strip_prefix(SIGNATURE_PREFIX)
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .ok_or_else(|| "runtime_evidence_transport_signature_shape_invalid".to_string())?;
    UnparsedPublicKey::new(&ED25519, verification_key.public_key_bytes()?)
        .verify(&signing_bytes, &signature)
        .map_err(|_| "runtime_evidence_transport_signature_mismatch".to_string())
}

fn validate_input(input: &RuntimeEvidenceTransportReceiptInput<'_>) -> Result<(), String> {
    if input.runner_process_id == 0
        || !canonical_token(input.runtime_session_id)
        || !canonical_hex(input.runner_challenge, 32)
        || !canonical_token(input.transport_session_id)
        || !canonical_request_id(input.request_id)
        || !canonical_source_edit_id(input.source_edit_id)
        || !canonical_token(input.subject_identity_namespace)
        || input.subject_canonical_bytes.is_empty()
        || !canonical_sha256(input.artifact_content_hash)
        || !canonical_runtime_proof_id(input.observed_runtime_proof_id)
        || !canonical_ledger_proof_id(input.observed_proof_ledger_id)
        || input.observed_payload.is_empty()
    {
        return Err("runtime_evidence_transport_input_invalid".to_string());
    }
    Ok(())
}

fn validate_verification_context(
    context: &RuntimeEvidenceTransportVerificationContext<'_>,
) -> Result<(), String> {
    if !canonical_prefixed_sha256(context.worker_instance_id, WORKER_INSTANCE_ID_PREFIX)
        || context.worker_process_id == 0
        || context.runner_process_id == 0
        || !canonical_token(context.runtime_session_id)
        || !canonical_hex(context.runner_challenge, 32)
        || !canonical_token(context.transport_session_id)
        || !canonical_request_id(context.request_id)
        || !canonical_source_edit_id(context.source_edit_id)
        || !canonical_token(context.subject_identity_namespace)
        || context.subject_canonical_bytes.is_empty()
        || !canonical_sha256(context.artifact_content_hash)
        || !canonical_runtime_proof_id(context.observed_runtime_proof_id)
        || !canonical_ledger_proof_id(context.observed_proof_ledger_id)
    {
        return Err("runtime_evidence_transport_verification_context_invalid".to_string());
    }
    Ok(())
}

fn observation_context_hash(material: ObservationContextMaterial<'_>) -> Result<String, String> {
    let bytes = serde_json::to_vec(&json!([
        OBSERVATION_CONTEXT_DOMAIN,
        material.key_id,
        material.worker_instance_id,
        material.worker_process_id,
        material.runner_process_id,
        material.runtime_session_id,
        material.runner_challenge_sha256,
        material.transport_session_binding_sha256,
        material.request_id,
        material.source_edit_id,
        material.subject_identity_namespace,
        material.subject_identity_hash,
        material.artifact_content_hash,
        material.observed_runtime_proof_id,
        material.observed_proof_ledger_id,
        material.observed_payload_sha256,
    ]))
    .map_err(|error| {
        format!("runtime_evidence_transport_context_material_serialize_failed:{error}")
    })?;
    Ok(prefixed_sha256(&bytes))
}

fn subject_identity_hash(namespace: &str, canonical_bytes: &[u8]) -> Result<String, String> {
    let canonical_bytes_sha256 = prefixed_sha256(canonical_bytes);
    let material = serde_json::to_vec(&json!([
        SUBJECT_IDENTITY_DOMAIN,
        namespace,
        canonical_bytes_sha256,
    ]))
    .map_err(|error| {
        format!("runtime_evidence_transport_subject_material_serialize_failed:{error}")
    })?;
    Ok(prefixed_sha256(&material))
}

fn transport_session_binding(session_id: &str) -> String {
    prefixed_sha256(format!("required\0{session_id}").as_bytes())
}

fn system_time_unix_ns() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "runtime_evidence_transport_clock_before_epoch".to_string())
        .map(|duration| duration.as_nanos())
}

fn prefixed_sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn random_hex_32() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn canonical_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_prefixed_sha256(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|digest| canonical_hex(digest, 64))
}

fn canonical_sha256(value: &str) -> bool {
    canonical_prefixed_sha256(value, "sha256:")
}

fn canonical_request_id(value: &str) -> bool {
    value
        .strip_prefix("gpu-reload:request:")
        .is_some_and(|id| canonical_hex(id, 32))
}

fn canonical_source_edit_id(value: &str) -> bool {
    value
        .strip_prefix("source-edit:sha256:")
        .is_some_and(|digest| canonical_hex(digest, 64))
}

fn canonical_runtime_proof_id(value: &str) -> bool {
    value
        .strip_prefix("gpu-runtime-proof:sha256:")
        .is_some_and(|digest| canonical_hex(digest, 64))
}

fn canonical_ledger_proof_id(value: &str) -> bool {
    value
        .strip_prefix("gpu-ledger-proof:sha256:")
        .is_some_and(|digest| canonical_hex(digest, 64))
}

fn canonical_decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) && !value.starts_with('0')
}

fn canonical_u32(value: &str) -> bool {
    canonical_decimal(value) && value.parse::<u32>().is_ok()
}

fn canonical_u64(value: &str) -> bool {
    canonical_decimal(value) && value.parse::<u64>().is_ok()
}

fn canonical_u128(value: &str) -> bool {
    canonical_decimal(value) && value.parse::<u128>().is_ok()
}

fn canonical_base64url(value: &str, expected_length: usize) -> bool {
    URL_SAFE_NO_PAD.decode(value).is_ok_and(|decoded| {
        decoded.len() == expected_length && URL_SAFE_NO_PAD.encode(&decoded) == value
    })
}

fn canonical_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.is_ascii()
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const OBSERVED_PAYLOAD: &[u8] =
        br#"{"type":"gpu_hmr_proof","proofId":"gpu-runtime-proof:sha256:fixture"}"#;
    const SUBJECT_NAMESPACE: &str = "synthi.test.canonical_subject_manifest.v1";
    const SUBJECT_CANONICAL_BYTES: &[u8] = br#"{"project":"arbitrary-test-subject"}"#;

    #[derive(Default)]
    struct TestReplayStore {
        entries: Mutex<HashMap<(String, String, String), (u64, String)>>,
    }

    impl RuntimeEvidenceTransportReplayStore for TestReplayStore {
        fn consume_if_newer(
            &self,
            key_id: &str,
            worker_instance_id: &str,
            transport_session_binding_sha256: &str,
            sequence: u64,
            receipt_id: &str,
        ) -> Result<(), String> {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "runtime_evidence_transport_replay_store_poisoned".to_string())?;
            let entry = entries
                .entry((
                    key_id.to_string(),
                    worker_instance_id.to_string(),
                    transport_session_binding_sha256.to_string(),
                ))
                .or_insert((0, String::new()));
            if sequence <= entry.0 || entry.1 == receipt_id {
                return Err("runtime_evidence_transport_receipt_replayed".to_string());
            }
            *entry = (sequence, receipt_id.to_string());
            Ok(())
        }
    }

    fn input<'a>() -> RuntimeEvidenceTransportReceiptInput<'a> {
        RuntimeEvidenceTransportReceiptInput {
            runner_process_id: 42,
            runtime_session_id: "pid:42:boot:runtime-session",
            runner_challenge: "3".repeat(32).leak(),
            transport_session_id: "workspace-session",
            request_id: format!("gpu-reload:request:{}", "4".repeat(32)).leak(),
            source_edit_id: format!("source-edit:sha256:{}", "5".repeat(64)).leak(),
            subject_identity_namespace: SUBJECT_NAMESPACE,
            subject_canonical_bytes: SUBJECT_CANONICAL_BYTES,
            artifact_content_hash: format!("sha256:{}", "6".repeat(64)).leak(),
            observed_runtime_proof_id: format!("gpu-runtime-proof:sha256:{}", "7".repeat(64))
                .leak(),
            observed_proof_ledger_id: format!("gpu-ledger-proof:sha256:{}", "8".repeat(64)).leak(),
            observed_payload: OBSERVED_PAYLOAD,
        }
    }

    fn verification_context<'a>(
        signer: &'a RuntimeEvidenceTransportSigner,
    ) -> RuntimeEvidenceTransportVerificationContext<'a> {
        RuntimeEvidenceTransportVerificationContext {
            worker_instance_id: &signer.verification_key().worker_instance_id,
            worker_process_id: 41,
            runner_process_id: 42,
            runtime_session_id: "pid:42:boot:runtime-session",
            runner_challenge: "3".repeat(32).leak(),
            transport_session_id: "workspace-session",
            request_id: format!("gpu-reload:request:{}", "4".repeat(32)).leak(),
            source_edit_id: format!("source-edit:sha256:{}", "5".repeat(64)).leak(),
            subject_identity_namespace: SUBJECT_NAMESPACE,
            subject_canonical_bytes: SUBJECT_CANONICAL_BYTES,
            artifact_content_hash: format!("sha256:{}", "6".repeat(64)).leak(),
            observed_runtime_proof_id: format!("gpu-runtime-proof:sha256:{}", "7".repeat(64))
                .leak(),
            observed_proof_ledger_id: format!("gpu-ledger-proof:sha256:{}", "8".repeat(64)).leak(),
        }
    }

    fn worker_pin(signer: &RuntimeEvidenceTransportSigner) -> RuntimeEvidenceTransportWorkerPin {
        let key = signer.verification_key();
        RuntimeEvidenceTransportWorkerPin::from_authenticated_control_plane(
            key.key_id(),
            key.worker_instance_id(),
            key.worker_process_id().unwrap(),
            key.key_announcement_id(),
        )
        .unwrap()
    }

    fn consumer(
        signer: &RuntimeEvidenceTransportSigner,
        now_unix_ns: u128,
        replay_store: Arc<dyn RuntimeEvidenceTransportReplayStore>,
    ) -> RuntimeEvidenceTransportReceiptConsumer {
        RuntimeEvidenceTransportReceiptConsumer::new_with_clock(
            signer.verification_key().clone(),
            worker_pin(signer),
            RuntimeEvidenceTransportFreshnessPolicy::new(
                Duration::from_secs(5),
                Duration::from_millis(50),
            )
            .unwrap(),
            replay_store,
            Arc::new(move || Ok(now_unix_ns)),
        )
        .unwrap()
    }

    fn envelope_at(
        signer: &RuntimeEvidenceTransportSigner,
        issued_at_unix_ns: u128,
        sequence: u64,
        nonce: char,
    ) -> ObservedRuntimeEvidenceEnvelope {
        let receipt = signer
            .issue_at(
                input(),
                issued_at_unix_ns.to_string(),
                sequence.to_string(),
                nonce.to_string().repeat(64),
            )
            .unwrap();
        ObservedRuntimeEvidenceEnvelope::new(OBSERVED_PAYLOAD, receipt).unwrap()
    }

    #[test]
    fn transport_receipt_signature_is_bound_to_every_observation_identity_field() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let receipt = signer
            .issue_at(
                input(),
                "1784379315000000000".to_string(),
                "1".to_string(),
                "a".repeat(64),
            )
            .unwrap();
        verify_runtime_evidence_transport_receipt_signature(&receipt, signer.verification_key())
            .unwrap();

        let encoded = serde_json::to_string(&receipt).unwrap();
        let decoded: RuntimeEvidenceTransportReceipt = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, receipt);
        assert_eq!(
            receipt.schema_version,
            RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION
        );
        assert!(receipt.receipt_id.starts_with(RECEIPT_ID_PREFIX));
        assert!(receipt.signature.starts_with(SIGNATURE_PREFIX));

        for field in [
            "runnerProcessId",
            "runtimeSessionId",
            "runnerChallengeSha256",
            "transportSessionBindingSha256",
            "requestId",
            "sourceEditId",
            "subjectIdentityNamespace",
            "subjectIdentityHash",
            "artifactContentHash",
            "observedRuntimeProofId",
            "observedProofLedgerId",
            "observedPayloadSha256",
            "observationContextHash",
            "issuedAtUnixNs",
            "sequence",
            "nonce",
        ] {
            let mut forged = serde_json::to_value(&receipt).unwrap();
            forged[field] = match field {
                "runnerProcessId" => json!("43"),
                "runtimeSessionId" => json!("pid:43:boot:runtime-session"),
                "subjectIdentityNamespace" => json!("synthi.test.other_subject_manifest.v1"),
                "runnerChallengeSha256"
                | "transportSessionBindingSha256"
                | "subjectIdentityHash"
                | "artifactContentHash"
                | "observedPayloadSha256"
                | "observationContextHash" => json!(format!("sha256:{}", "b".repeat(64))),
                "requestId" => json!(format!("gpu-reload:request:{}", "b".repeat(32))),
                "sourceEditId" => json!(format!("source-edit:sha256:{}", "b".repeat(64))),
                "observedRuntimeProofId" => {
                    json!(format!("gpu-runtime-proof:sha256:{}", "b".repeat(64)))
                }
                "observedProofLedgerId" => {
                    json!(format!("gpu-ledger-proof:sha256:{}", "b".repeat(64)))
                }
                "issuedAtUnixNs" => json!("1784379315000000001"),
                "sequence" => json!("2"),
                "nonce" => json!("b".repeat(64)),
                _ => unreachable!(),
            };
            let forged: RuntimeEvidenceTransportReceipt = serde_json::from_value(forged).unwrap();
            assert!(
                verify_runtime_evidence_transport_receipt_signature(
                    &forged,
                    signer.verification_key(),
                )
                .is_err(),
                "accepted forged {field}"
            );
        }

        let mut transitively_forged = receipt.clone();
        transitively_forged.subject_identity_namespace =
            "synthi.test.other_subject_manifest.v1".to_string();
        transitively_forged.observation_context_hash =
            observation_context_hash(transitively_forged.context_material()).unwrap();
        transitively_forged.receipt_id = format!(
            "{RECEIPT_ID_PREFIX}{}",
            sha256_hex(&transitively_forged.signing_bytes().unwrap())
        );
        assert_eq!(
            verify_runtime_evidence_transport_receipt_signature(
                &transitively_forged,
                signer.verification_key(),
            )
            .unwrap_err(),
            "runtime_evidence_transport_signature_mismatch"
        );
    }

    #[test]
    fn transport_key_and_receipt_reject_self_declared_authority() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        signer.verification_key().validate_shape().unwrap();
        let receipt = signer.issue(input()).unwrap();

        let mut unknown = serde_json::to_value(&receipt).unwrap();
        unknown["gpuHmrSuccess"] = json!(true);
        assert!(serde_json::from_value::<RuntimeEvidenceTransportReceipt>(unknown).is_err());

        let other = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        assert!(verify_runtime_evidence_transport_receipt_signature(
            &receipt,
            other.verification_key(),
        )
        .is_err());

        let mut forged_key = signer.verification_key().clone();
        forged_key.public_key = other.verification_key().public_key.clone();
        assert!(forged_key.validate_shape().is_err());

        let mut invalid = input();
        invalid.observed_runtime_proof_id = "declared-success";
        assert!(signer.issue(invalid).is_err());

        let substituted = RuntimeEvidenceTransportReceiptConsumer::new(
            other.verification_key().clone(),
            worker_pin(&signer),
            RuntimeEvidenceTransportFreshnessPolicy::new(
                Duration::from_secs(5),
                Duration::from_millis(50),
            )
            .unwrap(),
            Arc::new(TestReplayStore::default()),
        );
        assert_eq!(
            substituted.err().unwrap(),
            "runtime_evidence_transport_worker_pin_mismatch"
        );
    }

    #[test]
    fn support_receipt_consumer_binds_context_and_consumes_sequence_once() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let issued_at = 1_784_379_315_000_000_000_u128;
        let envelope_one = envelope_at(&signer, issued_at, 1, 'a');
        let replay_store = Arc::new(TestReplayStore::default());
        let consumer_one = consumer(&signer, issued_at + 1_000_000, replay_store.clone());
        let consumer_two = consumer(&signer, issued_at + 1_000_000, replay_store);
        let context = verification_context(&signer);

        let consumed = consumer_one
            .consume_support_envelope(&envelope_one, OBSERVED_PAYLOAD, context)
            .unwrap();
        assert!(!consumed.accepted_for_gpu_hmr());
        assert!(!consumed.gpu_hmr_success());
        assert!(!consumed.can_satisfy_runtime_proof());
        assert!(consumed.receipt_id().starts_with(RECEIPT_ID_PREFIX));
        assert!(canonical_sha256(consumed.observation_context_hash()));
        assert_eq!(
            consumer_one
                .consume_support_envelope(&envelope_one, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_receipt_replayed"
        );
        assert_eq!(
            consumer_two
                .consume_support_envelope(&envelope_one, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_receipt_replayed"
        );

        let envelope_two = envelope_at(&signer, issued_at + 1, 2, 'b');
        let _ = consumer_two
            .consume_support_envelope(&envelope_two, OBSERVED_PAYLOAD, context)
            .unwrap();
    }

    #[test]
    fn support_receipt_consumer_rejects_context_mismatch() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let issued_at = 1_784_379_315_000_000_000_u128;
        let envelope = envelope_at(&signer, issued_at, 1, 'a');
        let consumer = consumer(
            &signer,
            issued_at + 1_000_000,
            Arc::new(TestReplayStore::default()),
        );

        let mut context = verification_context(&signer);
        context.subject_canonical_bytes = br#"{"project":"different-subject"}"#;
        assert_eq!(
            consumer
                .consume_support_envelope(&envelope, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_verification_context_mismatch"
        );

        let mut context = verification_context(&signer);
        context.subject_identity_namespace = "synthi.test.other_subject_manifest.v1";
        assert_eq!(
            consumer
                .consume_support_envelope(&envelope, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_verification_context_mismatch"
        );

        let mut context = verification_context(&signer);
        context.runner_challenge = "b".repeat(32).leak();
        assert_eq!(
            consumer
                .consume_support_envelope(&envelope, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_verification_context_mismatch"
        );

        let mut context = verification_context(&signer);
        context.transport_session_id = "other-workspace-session";
        assert_eq!(
            consumer
                .consume_support_envelope(&envelope, OBSERVED_PAYLOAD, context)
                .unwrap_err(),
            "runtime_evidence_transport_verification_context_mismatch"
        );

        assert_eq!(
            consumer
                .consume_support_envelope(
                    &envelope,
                    b"different-payload",
                    verification_context(&signer)
                )
                .unwrap_err(),
            "runtime_evidence_transport_observed_payload_hash_mismatch"
        );

        let _ = consumer
            .consume_support_envelope(&envelope, OBSERVED_PAYLOAD, verification_context(&signer))
            .unwrap();
    }

    #[test]
    fn support_receipt_consumer_rejects_stale_and_future_receipts() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let issued_at = 1_784_379_315_000_000_000_u128;
        let envelope = envelope_at(&signer, issued_at, 1, 'a');

        let stale_consumer = consumer(
            &signer,
            issued_at + 5_000_000_001,
            Arc::new(TestReplayStore::default()),
        );
        assert_eq!(
            stale_consumer
                .consume_support_envelope(
                    &envelope,
                    OBSERVED_PAYLOAD,
                    verification_context(&signer)
                )
                .unwrap_err(),
            "runtime_evidence_transport_receipt_expired"
        );

        let future_consumer = consumer(
            &signer,
            issued_at - 50_000_001,
            Arc::new(TestReplayStore::default()),
        );
        assert_eq!(
            future_consumer
                .consume_support_envelope(
                    &envelope,
                    OBSERVED_PAYLOAD,
                    verification_context(&signer)
                )
                .unwrap_err(),
            "runtime_evidence_transport_receipt_from_future"
        );

        assert!(RuntimeEvidenceTransportFreshnessPolicy::new(
            Duration::from_secs(301),
            Duration::ZERO,
        )
        .is_err());
        assert!(RuntimeEvidenceTransportFreshnessPolicy::new(
            Duration::from_secs(5),
            Duration::from_secs(31),
        )
        .is_err());

        let mut missing_transport = input();
        missing_transport.transport_session_id = "";
        assert!(signer.issue(missing_transport).is_err());
    }

    #[test]
    fn observed_delivery_pairs_exact_payload_bytes_with_signed_envelope() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let issued_at = 1_784_379_315_000_000_000_u128;
        let envelope = envelope_at(&signer, issued_at, 1, 'a');
        let delivery =
            ObservedRuntimeEvidenceDelivery::new(OBSERVED_PAYLOAD, envelope.clone()).unwrap();

        assert_eq!(
            ObservedRuntimeEvidenceDelivery::new(&[], envelope.clone()).unwrap_err(),
            "observed_runtime_evidence_delivery_payload_empty"
        );
        delivery.validate_shape().unwrap();
        assert_eq!(
            delivery.decode_payload_and_validate().unwrap(),
            OBSERVED_PAYLOAD
        );
        assert_eq!(delivery.runtime_evidence_transport_envelope, envelope);
        assert!(!delivery.accepted_for_gpu_hmr);
        assert!(!delivery.gpu_hmr_success);
        assert!(!delivery.can_satisfy_runtime_proof);

        let encoded = delivery.serialize_for_transport().unwrap();
        let decoded: ObservedRuntimeEvidenceDelivery = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, delivery);

        let mut altered_payload = delivery.clone();
        altered_payload.observed_payload_base64 = URL_SAFE_NO_PAD.encode(b"altered-payload");
        altered_payload.observed_payload_byte_length = b"altered-payload".len().to_string();
        assert_eq!(
            altered_payload.validate_shape().unwrap_err(),
            "observed_runtime_evidence_delivery_payload_envelope_hash_mismatch"
        );

        let mut padded_payload = delivery.clone();
        padded_payload.observed_payload_base64.push('=');
        assert_eq!(
            padded_payload.validate_shape().unwrap_err(),
            "observed_runtime_evidence_delivery_payload_encoding_invalid"
        );

        let mut noncanonical_length = delivery.clone();
        noncanonical_length.observed_payload_byte_length =
            format!("0{}", noncanonical_length.observed_payload_byte_length);
        assert_eq!(
            noncanonical_length.validate_shape().unwrap_err(),
            "observed_runtime_evidence_delivery_shape_invalid"
        );

        let oversized_payload =
            vec![0_u8; OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES as usize + 1];
        assert_eq!(
            ObservedRuntimeEvidenceDelivery::new(&oversized_payload, envelope.clone()).unwrap_err(),
            "observed_runtime_evidence_delivery_payload_too_large"
        );
        let mut oversized_claim = delivery.clone();
        oversized_claim.observed_payload_byte_length =
            (OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES + 1).to_string();
        assert_eq!(
            oversized_claim.validate_shape().unwrap_err(),
            "observed_runtime_evidence_delivery_payload_too_large"
        );

        let mut altered_envelope = delivery.clone();
        altered_envelope
            .runtime_evidence_transport_envelope
            .observed_payload_sha256 = prefixed_sha256(b"altered-payload");
        assert!(altered_envelope.validate_shape().is_err());

        let mut forged_authority = serde_json::to_value(&delivery).unwrap();
        forged_authority["gpuHmrSuccess"] = json!(true);
        let forged_authority: ObservedRuntimeEvidenceDelivery =
            serde_json::from_value(forged_authority).unwrap();
        assert_eq!(
            forged_authority.validate_shape().unwrap_err(),
            "observed_runtime_evidence_delivery_shape_invalid"
        );
        assert_eq!(
            forged_authority.serialize_for_transport().unwrap_err(),
            "observed_runtime_evidence_delivery_shape_invalid"
        );

        let mut unknown_field = serde_json::to_value(&delivery).unwrap();
        unknown_field["unexpectedField"] = json!(true);
        assert!(serde_json::from_value::<ObservedRuntimeEvidenceDelivery>(unknown_field).is_err());
    }

    #[test]
    fn observed_envelope_retains_only_a_hash_without_promoting_child_payload() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let issued_at = 1_784_379_315_000_000_000_u128;
        let envelope = envelope_at(&signer, issued_at, 1, 'a');

        envelope.validate_shape().unwrap();
        assert!(!envelope.accepted_for_gpu_hmr);
        assert!(!envelope.gpu_hmr_success);
        assert!(!envelope.can_satisfy_runtime_proof);
        verify_runtime_evidence_transport_receipt_signature(
            &envelope.runtime_evidence_transport_receipt,
            signer.verification_key(),
        )
        .unwrap();

        let encoded = serde_json::to_string(&envelope).unwrap();
        assert!(!encoded.contains("proofPayload"));
        assert!(!encoded.contains("gpu-runtime-proof:sha256:fixture"));
        let decoded: ObservedRuntimeEvidenceEnvelope = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, envelope);

        let mut forged_payload = envelope.clone();
        forged_payload.observed_payload_sha256 = prefixed_sha256(b"{}");
        assert!(forged_payload.validate_shape().is_err());

        let mut forged_authority = serde_json::to_value(&envelope).unwrap();
        forged_authority["gpuHmrSuccess"] = json!(true);
        let forged_authority: ObservedRuntimeEvidenceEnvelope =
            serde_json::from_value(forged_authority).unwrap();
        assert!(forged_authority.validate_shape().is_err());

        let consumer = consumer(
            &signer,
            issued_at + 1_000_000,
            Arc::new(TestReplayStore::default()),
        );
        assert_eq!(
            consumer
                .consume_support_envelope(
                    &forged_authority,
                    OBSERVED_PAYLOAD,
                    verification_context(&signer),
                )
                .unwrap_err(),
            "observed_runtime_evidence_envelope_shape_invalid"
        );
    }
}
