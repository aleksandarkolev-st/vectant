use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_receipt.v1";
pub const RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1";
pub const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM: &str = "ed25519";
pub const RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL: &str = "gpu-hmr-evidence-transport";
pub const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.observed_runtime_evidence_envelope.v1";
pub const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE: &str = "gpu_hmr_observed_runtime_evidence";
pub const OBSERVED_RUNTIME_EVIDENCE_AUTHORITY: &str =
    "worker_signed_observation_transport_only_not_gpu_hmr_acceptance";
const RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER: &str = "synthi-webrtc-compiler-worker";
const KEY_ID_PREFIX: &str = "gpu-hmr-runtime-evidence-transport-key:sha256:";
const RECEIPT_ID_PREFIX: &str = "gpu-hmr-runtime-evidence-transport-receipt:sha256:";
const KEY_ANNOUNCEMENT_ID_PREFIX: &str =
    "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const WORKER_INSTANCE_ID_PREFIX: &str = "gpu-hmr-worker-instance:sha256:";
const SIGNATURE_PREFIX: &str = "ed25519:";

static GLOBAL_TRANSPORT_SIGNER: OnceLock<Result<RuntimeEvidenceTransportSigner, String>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub struct RuntimeEvidenceTransportReceiptInput<'a> {
    pub runner_process_id: u32,
    pub runtime_session_id: &'a str,
    pub runner_challenge: &'a str,
    pub transport_session_id: Option<&'a str>,
    pub request_id: &'a str,
    pub source_edit_id: &'a str,
    pub artifact_content_hash: &'a str,
    pub observed_runtime_proof_id: &'a str,
    pub observed_proof_ledger_id: &'a str,
    pub observed_payload_sha256: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidenceTransportVerificationKey {
    pub schema_version: String,
    pub algorithm: String,
    pub key_id: String,
    pub producer: String,
    pub worker_instance_id: String,
    pub worker_process_id: String,
    pub public_key: String,
    pub key_announcement_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidenceTransportReceipt {
    pub schema_version: String,
    pub algorithm: String,
    pub key_id: String,
    pub producer: String,
    pub worker_instance_id: String,
    pub worker_process_id: String,
    pub runner_process_id: String,
    pub runtime_session_id: String,
    pub runner_challenge_sha256: String,
    pub transport_session_binding_sha256: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
    pub observed_runtime_proof_id: String,
    pub observed_proof_ledger_id: String,
    pub observed_payload_sha256: String,
    pub issued_at_unix_ns: String,
    pub sequence: String,
    pub nonce: String,
    pub receipt_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedRuntimeEvidenceEnvelope {
    pub schema_version: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub observed_payload_sha256: String,
    pub runtime_evidence_transport_receipt: RuntimeEvidenceTransportReceipt,
    pub proof_authority: String,
    pub accepted_for_gpu_hmr: bool,
    pub gpu_hmr_success: bool,
    pub can_satisfy_runtime_proof: bool,
}

#[derive(Clone)]
pub struct RuntimeEvidenceTransportSigner {
    key_pair: Arc<Ed25519KeyPair>,
    verification_key: RuntimeEvidenceTransportVerificationKey,
    sequence: Arc<AtomicU64>,
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

        let mut receipt = RuntimeEvidenceTransportReceipt {
            schema_version: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_SCHEMA_VERSION.to_string(),
            algorithm: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_ALGORITHM.to_string(),
            key_id: self.verification_key.key_id.clone(),
            producer: RUNTIME_EVIDENCE_TRANSPORT_RECEIPT_PRODUCER.to_string(),
            worker_instance_id: self.verification_key.worker_instance_id.clone(),
            worker_process_id: self.verification_key.worker_process_id.clone(),
            runner_process_id: input.runner_process_id.to_string(),
            runtime_session_id: input.runtime_session_id.to_string(),
            runner_challenge_sha256: prefixed_sha256(input.runner_challenge.as_bytes()),
            transport_session_binding_sha256: transport_session_binding(input.transport_session_id),
            request_id: input.request_id.to_string(),
            source_edit_id: input.source_edit_id.to_string(),
            artifact_content_hash: input.artifact_content_hash.to_string(),
            observed_runtime_proof_id: input.observed_runtime_proof_id.to_string(),
            observed_proof_ledger_id: input.observed_proof_ledger_id.to_string(),
            observed_payload_sha256: input.observed_payload_sha256.to_string(),
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

    pub fn validate_shape(&self) -> Result<(), String> {
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
            self.artifact_content_hash,
            self.observed_runtime_proof_id,
            self.observed_proof_ledger_id,
            self.observed_payload_sha256,
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
            || !canonical_sha256(&self.artifact_content_hash)
            || !canonical_runtime_proof_id(&self.observed_runtime_proof_id)
            || !canonical_ledger_proof_id(&self.observed_proof_ledger_id)
            || !canonical_sha256(&self.observed_payload_sha256)
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
        Ok(())
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

    pub fn validate_shape(&self) -> Result<(), String> {
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

pub fn initialize_runtime_evidence_transport_signer() -> Result<(), String> {
    harden_runtime_evidence_transport_signer_process()?;
    let signer = RuntimeEvidenceTransportSigner::generate(std::process::id());
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

pub fn verify_runtime_evidence_transport_receipt(
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
        || input
            .transport_session_id
            .is_some_and(|value| !canonical_token(value))
        || !canonical_request_id(input.request_id)
        || !canonical_source_edit_id(input.source_edit_id)
        || !canonical_sha256(input.artifact_content_hash)
        || !canonical_runtime_proof_id(input.observed_runtime_proof_id)
        || !canonical_ledger_proof_id(input.observed_proof_ledger_id)
        || !canonical_sha256(input.observed_payload_sha256)
    {
        return Err("runtime_evidence_transport_input_invalid".to_string());
    }
    Ok(())
}

fn transport_session_binding(session_id: Option<&str>) -> String {
    let material = match session_id {
        Some(value) => format!("present\0{value}"),
        None => "absent".to_string(),
    };
    prefixed_sha256(material.as_bytes())
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

    fn input<'a>() -> RuntimeEvidenceTransportReceiptInput<'a> {
        RuntimeEvidenceTransportReceiptInput {
            runner_process_id: 42,
            runtime_session_id: "pid:42:boot:runtime-session",
            runner_challenge: "3".repeat(32).leak(),
            transport_session_id: Some("workspace-session"),
            request_id: format!("gpu-reload:request:{}", "4".repeat(32)).leak(),
            source_edit_id: format!("source-edit:sha256:{}", "5".repeat(64)).leak(),
            artifact_content_hash: format!("sha256:{}", "6".repeat(64)).leak(),
            observed_runtime_proof_id: format!("gpu-runtime-proof:sha256:{}", "7".repeat(64))
                .leak(),
            observed_proof_ledger_id: format!("gpu-ledger-proof:sha256:{}", "8".repeat(64)).leak(),
            observed_payload_sha256: format!("sha256:{}", "9".repeat(64)).leak(),
        }
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
        verify_runtime_evidence_transport_receipt(&receipt, signer.verification_key()).unwrap();

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
            "artifactContentHash",
            "observedRuntimeProofId",
            "observedProofLedgerId",
            "observedPayloadSha256",
            "issuedAtUnixNs",
            "sequence",
            "nonce",
        ] {
            let mut forged = serde_json::to_value(&receipt).unwrap();
            forged[field] = match field {
                "runnerProcessId" => json!("43"),
                "runtimeSessionId" => json!("pid:43:boot:runtime-session"),
                "runnerChallengeSha256"
                | "transportSessionBindingSha256"
                | "artifactContentHash"
                | "observedPayloadSha256" => json!(format!("sha256:{}", "b".repeat(64))),
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
                verify_runtime_evidence_transport_receipt(&forged, signer.verification_key())
                    .is_err(),
                "accepted forged {field}"
            );
        }
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
        assert!(
            verify_runtime_evidence_transport_receipt(&receipt, other.verification_key()).is_err()
        );

        let mut forged_key = signer.verification_key().clone();
        forged_key.public_key = other.verification_key().public_key.clone();
        assert!(forged_key.validate_shape().is_err());

        let mut invalid = input();
        invalid.observed_runtime_proof_id = "declared-success";
        assert!(signer.issue(invalid).is_err());
    }

    #[test]
    fn observed_envelope_retains_only_a_hash_without_promoting_child_payload() {
        let signer = RuntimeEvidenceTransportSigner::generate(41).unwrap();
        let payload = br#"{"type":"gpu_hmr_proof","proofId":"gpu-runtime-proof:sha256:fixture"}"#;
        let mut receipt_input = input();
        receipt_input.observed_payload_sha256 = prefixed_sha256(payload).leak();
        let receipt = signer.issue(receipt_input).unwrap();
        let envelope = ObservedRuntimeEvidenceEnvelope::new(payload, receipt.clone()).unwrap();

        envelope.validate_shape().unwrap();
        assert!(!envelope.accepted_for_gpu_hmr);
        assert!(!envelope.gpu_hmr_success);
        assert!(!envelope.can_satisfy_runtime_proof);
        verify_runtime_evidence_transport_receipt(
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
    }
}
