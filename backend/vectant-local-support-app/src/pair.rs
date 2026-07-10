use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{distributions::Alphanumeric, Rng};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_PAIRING_FIELD_BYTES: usize = 128;
const MAX_REQUESTED_USER_ID_BYTES: usize = 256;
#[cfg(windows)]
const DPAPI_FILE_PREFIX: &[u8] = b"VECTANT-DPAPI-V1\0";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRequestProof {
    pub session_id: String,
    pub device_fingerprint: String,
    pub timestamp: String,
    pub nonce: String,
    pub body_sha256: String,
    pub signature: String,
}

pub fn verify_device_request_proof(
    proof: &DeviceRequestProof,
    method: &str,
    path: &str,
    body: &[u8],
    device_public_key: &str,
) -> bool {
    if !fixed_hex(device_public_key, 64)
        || !fixed_hex(&proof.nonce, 32)
        || !fixed_hex(&proof.signature, 128)
        || !proof.timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || proof.timestamp.len() != 10
        || proof.body_sha256 != format!("sha256:{}", hex::encode(Sha256::digest(body)))
    {
        return false;
    }
    let Ok(public_key_bytes) = hex::decode(device_public_key).and_then(|bytes| {
        bytes
            .try_into()
            .map_err(|_| hex::FromHexError::InvalidStringLength)
    }) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&public_key_bytes) else {
        return false;
    };
    if proof.device_fingerprint != device_fingerprint(&verifying_key) {
        return false;
    }
    let Ok(signature) = Signature::from_slice(
        &hex::decode(&proof.signature).unwrap_or_default(),
    ) else {
        return false;
    };
    verifying_key
        .verify(
            &device_request_payload(
                method,
                path,
                &proof.session_id,
                &proof.device_fingerprint,
                &proof.timestamp,
                &proof.nonce,
                &proof.body_sha256,
            ),
            &signature,
        )
        .is_ok()
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

    pub fn from_private_key_hex(private_key_hex: &str) -> Result<Self, DeviceIdentityStoreError> {
        let private_key_bytes: [u8; 32] = hex::decode(private_key_hex)
            .map_err(|_| DeviceIdentityStoreError::InvalidPrivateKey)?
            .try_into()
            .map_err(|_| DeviceIdentityStoreError::InvalidPrivateKey)?;
        Ok(Self {
            signing_key: SigningKey::from_bytes(&private_key_bytes),
        })
    }

    fn private_key_hex(&self) -> String {
        hex::encode(self.signing_key.to_bytes())
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

    pub fn sign_device_request(
        &self,
        method: &str,
        path: &str,
        session_id: &str,
        body: &[u8],
    ) -> DeviceRequestProof {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        let nonce: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(16)
            .map(char::from)
            .collect::<String>();
        let nonce = hex::encode(nonce.as_bytes());
        self.sign_device_request_at(method, path, session_id, body, &timestamp, &nonce)
    }

    pub fn sign_device_request_at(
        &self,
        method: &str,
        path: &str,
        session_id: &str,
        body: &[u8],
        timestamp: &str,
        nonce: &str,
    ) -> DeviceRequestProof {
        let public = self.public_identity();
        let body_sha256 = format!("sha256:{}", hex::encode(Sha256::digest(body)));
        let payload = device_request_payload(
            method,
            path,
            session_id,
            &public.device_fingerprint,
            timestamp,
            nonce,
            &body_sha256,
        );
        DeviceRequestProof {
            session_id: session_id.to_string(),
            device_fingerprint: public.device_fingerprint,
            timestamp: timestamp.to_string(),
            nonce: nonce.to_string(),
            body_sha256,
            signature: hex::encode(self.signing_key.sign(&payload).to_bytes()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDeviceIdentity {
    version: u8,
    private_key_hex: String,
    device_public_key: String,
    device_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct DeviceIdentityStore {
    path: PathBuf,
}

impl DeviceIdentityStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_or_create(&self) -> Result<DeviceIdentity, DeviceIdentityStoreError> {
        match self.load() {
            Ok(identity) => Ok(identity),
            Err(DeviceIdentityStoreError::NotFound) => {
                let identity = DeviceIdentity::generate();
                self.persist(&identity)?;
                Ok(identity)
            }
            Err(err) => Err(err),
        }
    }

    pub fn load(&self) -> Result<DeviceIdentity, DeviceIdentityStoreError> {
        let raw = fs::read(&self.path).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                DeviceIdentityStoreError::NotFound
            } else {
                DeviceIdentityStoreError::Io
            }
        })?;
        if raw.len() > 8192 {
            return Err(DeviceIdentityStoreError::InvalidFormat);
        }
        let (plaintext, migrate) = decode_stored_identity(&raw)?;
        let stored: StoredDeviceIdentity = serde_json::from_slice(&plaintext)
            .map_err(|_| DeviceIdentityStoreError::InvalidFormat)?;
        if stored.version != 1 {
            return Err(DeviceIdentityStoreError::InvalidFormat);
        }
        let identity = DeviceIdentity::from_private_key_hex(&stored.private_key_hex)?;
        let public = identity.public_identity();
        if stored.device_public_key != public.device_public_key
            || stored.device_fingerprint != public.device_fingerprint
        {
            return Err(DeviceIdentityStoreError::PublicIdentityMismatch);
        }
        if migrate {
            self.persist(&identity)?;
        }
        Ok(identity)
    }

    pub fn persist(&self, identity: &DeviceIdentity) -> Result<(), DeviceIdentityStoreError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| DeviceIdentityStoreError::Io)?;
        }
        let public = identity.public_identity();
        let stored = StoredDeviceIdentity {
            version: 1,
            private_key_hex: identity.private_key_hex(),
            device_public_key: public.device_public_key,
            device_fingerprint: public.device_fingerprint,
        };
        let plaintext = serde_json::to_vec_pretty(&stored)
            .map_err(|_| DeviceIdentityStoreError::InvalidFormat)?;
        let raw = encode_stored_identity(&plaintext)?;
        write_private_identity_file(&self.path, &raw)
    }

    pub fn reset(&self) -> Result<DeviceIdentity, DeviceIdentityStoreError> {
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(|_| DeviceIdentityStoreError::Io)?;
        }
        let identity = DeviceIdentity::generate();
        self.persist(&identity)?;
        Ok(identity)
    }
}

#[cfg(not(windows))]
fn encode_stored_identity(plaintext: &[u8]) -> Result<Vec<u8>, DeviceIdentityStoreError> {
    Ok(plaintext.to_vec())
}

#[cfg(not(windows))]
fn decode_stored_identity(raw: &[u8]) -> Result<(Vec<u8>, bool), DeviceIdentityStoreError> {
    Ok((raw.to_vec(), false))
}

#[cfg(windows)]
fn encode_stored_identity(plaintext: &[u8]) -> Result<Vec<u8>, DeviceIdentityStoreError> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext
            .len()
            .try_into()
            .map_err(|_| DeviceIdentityStoreError::InvalidFormat)?,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if protected == 0 || output.pbData.is_null() {
        return Err(DeviceIdentityStoreError::Io);
    }
    let ciphertext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    let mut encoded = Vec::with_capacity(DPAPI_FILE_PREFIX.len() + ciphertext.len());
    encoded.extend_from_slice(DPAPI_FILE_PREFIX);
    encoded.extend_from_slice(&ciphertext);
    Ok(encoded)
}

#[cfg(windows)]
fn decode_stored_identity(raw: &[u8]) -> Result<(Vec<u8>, bool), DeviceIdentityStoreError> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let Some(ciphertext) = raw.strip_prefix(DPAPI_FILE_PREFIX) else {
        return Ok((raw.to_vec(), true));
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext
            .len()
            .try_into()
            .map_err(|_| DeviceIdentityStoreError::InvalidFormat)?,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let mut description = ptr::null_mut();
    let unprotected = unsafe {
        CryptUnprotectData(
            &input,
            &mut description,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if unprotected == 0 || output.pbData.is_null() {
        return Err(DeviceIdentityStoreError::InvalidFormat);
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
        if !description.is_null() {
            LocalFree(description.cast());
        }
    }
    Ok((plaintext, false))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceIdentityStoreError {
    NotFound,
    Io,
    InvalidFormat,
    InvalidPrivateKey,
    PublicIdentityMismatch,
}

impl std::fmt::Display for DeviceIdentityStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::NotFound => "device identity not found",
            Self::Io => "device identity storage unavailable",
            Self::InvalidFormat => "device identity storage invalid",
            Self::InvalidPrivateKey => "device identity private key invalid",
            Self::PublicIdentityMismatch => "device identity public fields mismatch",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for DeviceIdentityStoreError {}

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

    pub fn verify(
        &mut self,
        submitted_code: &str,
        submitted_fingerprint: &str,
    ) -> Result<(), PairingError> {
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
        if !valid_pairing_code(submitted_code)
            || !valid_pairing_fingerprint(submitted_fingerprint)
            || !constant_time_eq(submitted_code.as_bytes(), self.code.as_bytes())
            || !constant_time_eq(
                submitted_fingerprint.as_bytes(),
                self.fingerprint.as_bytes(),
            )
        {
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

#[cfg(unix)]
fn write_private_identity_file(path: &Path, raw: &[u8]) -> Result<(), DeviceIdentityStoreError> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| DeviceIdentityStoreError::Io)?;
    file.write_all(raw)
        .map_err(|_| DeviceIdentityStoreError::Io)?;
    file.sync_all().map_err(|_| DeviceIdentityStoreError::Io)
}

#[cfg(not(unix))]
fn write_private_identity_file(path: &Path, raw: &[u8]) -> Result<(), DeviceIdentityStoreError> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| DeviceIdentityStoreError::Io)?;
    file.write_all(raw)
        .map_err(|_| DeviceIdentityStoreError::Io)?;
    file.sync_all().map_err(|_| DeviceIdentityStoreError::Io)
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

fn valid_pairing_code(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn valid_pairing_fingerprint(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 14
        && bytes[4] == b'-'
        && bytes[9] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 9) || byte.is_ascii_hexdigit())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

fn device_request_payload(
    method: &str,
    path: &str,
    session_id: &str,
    device_fingerprint: &str,
    timestamp: &str,
    nonce: &str,
    body_sha256: &str,
) -> Vec<u8> {
    [
        "VECTANT-LOCAL-SUPPORT-DEVICE-V1",
        method,
        path,
        session_id,
        device_fingerprint,
        timestamp,
        nonce,
        body_sha256,
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

#[cfg(test)]
mod device_request_tests {
    use super::*;

    #[test]
    fn device_request_proof_binds_body_path_and_session() {
        let identity = DeviceIdentity::generate();
        let proof = identity.sign_device_request_at(
            "POST",
            "/api/local-support/relay/device",
            "sess_12345678",
            br#"{"action":"poll"}"#,
            "1893456000",
            "22222222222222222222222222222222",
        );
        let public_key = VerifyingKey::from_bytes(
            &hex::decode(identity.public_identity().device_public_key)
                .unwrap()
                .try_into()
                .unwrap(),
        )
        .unwrap();
        let signature = Signature::from_slice(&hex::decode(&proof.signature).unwrap()).unwrap();
        let payload = device_request_payload(
            "POST",
            "/api/local-support/relay/device",
            &proof.session_id,
            &proof.device_fingerprint,
            &proof.timestamp,
            &proof.nonce,
            &proof.body_sha256,
        );

        assert!(public_key.verify(&payload, &signature).is_ok());
        assert_eq!(proof.body_sha256.len(), 71);
        assert!(public_key
            .verify(
                &device_request_payload(
                    "POST",
                    "/api/local-support/relay/other",
                    &proof.session_id,
                    &proof.device_fingerprint,
                    &proof.timestamp,
                    &proof.nonce,
                    &proof.body_sha256,
                ),
                &signature,
            )
            .is_err());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn plaintext_device_identity_is_migrated_to_dpapi_on_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("legacy-device-identity.json");
        let identity = DeviceIdentity::generate();
        let public = identity.public_identity();
        let legacy = StoredDeviceIdentity {
            version: 1,
            private_key_hex: identity.private_key_hex(),
            device_public_key: public.device_public_key,
            device_fingerprint: public.device_fingerprint.clone(),
        };
        fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let loaded = DeviceIdentityStore::new(&path).load().unwrap();
        let migrated = fs::read(&path).unwrap();

        assert_eq!(
            loaded.public_identity().device_fingerprint,
            public.device_fingerprint
        );
        assert!(migrated.starts_with(DPAPI_FILE_PREFIX));
        assert!(!String::from_utf8_lossy(&migrated).contains("private_key_hex"));
    }
}
