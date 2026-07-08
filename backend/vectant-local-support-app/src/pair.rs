use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{distributions::Alphanumeric, Rng};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_PAIRING_FIELD_BYTES: usize = 128;
const MAX_REQUESTED_USER_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    pub fingerprint: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePublicIdentity {
    pub device_public_key: String,
    pub device_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingProof {
    pub pairing_id: String,
    pub server_nonce: String,
    pub browser_session_id: String,
    pub requested_user_id: String,
    pub device_public_key: String,
    pub device_fingerprint: String,
    pub signature: String,
}

#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    signing_key: SigningKey,
}

impl DeviceIdentity {
    pub fn generate() -> Self {
        Self {
            signing_key: SigningKey::generate(&mut OsRng),
        }
    }

    pub fn public_identity(&self) -> DevicePublicIdentity {
        let verifying_key = self.signing_key.verifying_key();
        let device_public_key = hex::encode(verifying_key.to_bytes());
        DevicePublicIdentity {
            device_fingerprint: device_fingerprint(&verifying_key),
            device_public_key,
        }
    }

    pub fn sign_pairing_challenge(
        &self,
        pairing_id: impl AsRef<str>,
        server_nonce: impl AsRef<str>,
        browser_session_id: impl AsRef<str>,
        requested_user_id: impl AsRef<str>,
    ) -> PairingProof {
        let public = self.public_identity();
        let payload = pairing_challenge_payload(
            pairing_id.as_ref(),
            server_nonce.as_ref(),
            browser_session_id.as_ref(),
            requested_user_id.as_ref(),
            &public.device_public_key,
        );
        let signature = self.signing_key.sign(&payload);
        PairingProof {
            pairing_id: pairing_id.as_ref().to_string(),
            server_nonce: server_nonce.as_ref().to_string(),
            browser_session_id: browser_session_id.as_ref().to_string(),
            requested_user_id: requested_user_id.as_ref().to_string(),
            device_public_key: public.device_public_key,
            device_fingerprint: public.device_fingerprint,
            signature: hex::encode(signature.to_bytes()),
        }
    }
}

#[derive(Debug)]
pub struct PairingSession {
    code: String,
    fingerprint: String,
    expires_at: Instant,
    attempts: u8,
    consumed: bool,
}

impl PairingSession {
    pub fn new(ttl: Duration) -> Self {
        let code: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(12)
            .map(char::from)
            .collect::<String>()
            .to_ascii_uppercase();
        let fingerprint = pairing_fingerprint(&code);
        Self {
            code,
            fingerprint,
            expires_at: Instant::now() + ttl,
            attempts: 0,
            consumed: false,
        }
    }

    pub fn public_code(&self) -> PairingCode {
        let now = Instant::now();
        let expires_in_seconds = self.expires_at.saturating_duration_since(now).as_secs();
        PairingCode {
            code: self.code.clone(),
            fingerprint: self.fingerprint.clone(),
            expires_in_seconds,
        }
    }

    pub fn verify(&mut self, submitted_code: &str, submitted_fingerprint: &str) -> Result<(), PairingError> {
        self.attempts = self.attempts.saturating_add(1);
        if self.attempts > 5 {
            return Err(PairingError::RateLimited);
        }
        if self.consumed {
            return Err(PairingError::Consumed);
        }
        if Instant::now() > self.expires_at {
            return Err(PairingError::Expired);
        }
        if submitted_code != self.code || submitted_fingerprint != self.fingerprint {
            return Err(PairingError::Mismatch);
        }
        self.consumed = true;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    Expired,
    Mismatch,
    Consumed,
    RateLimited,
    InvalidProof,
    BadPublicKey,
    BadSignature,
}

pub fn verify_pairing_proof(proof: &PairingProof) -> Result<(), PairingError> {
    if !valid_pairing_proof_shape(proof) {
        return Err(PairingError::InvalidProof);
    }
    let public_key_bytes: [u8; 32] = hex::decode(&proof.device_public_key)
        .map_err(|_| PairingError::BadPublicKey)?
        .try_into()
        .map_err(|_| PairingError::BadPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_key_bytes).map_err(|_| PairingError::BadPublicKey)?;
    if proof.device_fingerprint != device_fingerprint(&verifying_key) {
        return Err(PairingError::BadPublicKey);
    }

    let signature_bytes: [u8; 64] = hex::decode(&proof.signature)
        .map_err(|_| PairingError::BadSignature)?
        .try_into()
        .map_err(|_| PairingError::BadSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    let payload = pairing_challenge_payload(
        &proof.pairing_id,
        &proof.server_nonce,
        &proof.browser_session_id,
        &proof.requested_user_id,
        &proof.device_public_key,
    );
    verifying_key
        .verify(&payload, &signature)
        .map_err(|_| PairingError::BadSignature)
}

fn valid_pairing_proof_shape(proof: &PairingProof) -> bool {
    safe_pairing_field(&proof.pairing_id, MAX_PAIRING_FIELD_BYTES)
        && safe_pairing_field(&proof.server_nonce, MAX_PAIRING_FIELD_BYTES)
        && safe_pairing_field(&proof.browser_session_id, MAX_PAIRING_FIELD_BYTES)
        && safe_pairing_field(&proof.requested_user_id, MAX_REQUESTED_USER_ID_BYTES)
        && fixed_hex(&proof.device_public_key, 64)
        && fixed_hex(&proof.signature, 128)
        && fixed_device_fingerprint(&proof.device_fingerprint)
}

fn safe_pairing_field(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.bytes().all(|byte| matches!(byte, 0x21..=0x7e))
}

fn fixed_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn fixed_device_fingerprint(value: &str) -> bool {
    match value.strip_prefix("sha256:") {
        Some(digest) => fixed_hex(digest, 16),
        None => false,
    }
}

fn pairing_fingerprint(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-pairing:");
    hasher.update(code.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{}-{}-{}", &digest[0..4], &digest[4..8], &digest[8..12])
}

fn device_fingerprint(verifying_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-device:");
    hasher.update(verifying_key.to_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("sha256:{}", &digest[0..16])
}

fn pairing_challenge_payload(
    pairing_id: &str,
    server_nonce: &str,
    browser_session_id: &str,
    requested_user_id: &str,
    device_public_key: &str,
) -> Vec<u8> {
    [
        "vectant-local-support-pairing-proof-v1",
        pairing_id,
        server_nonce,
        browser_session_id,
        requested_user_id,
        device_public_key,
    ]
    .iter()
    .flat_map(|part| {
        let bytes = part.as_bytes();
        let mut framed = Vec::with_capacity(bytes.len() + 8);
        framed.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        framed.extend_from_slice(bytes);
        framed
    })
    .collect()
}
