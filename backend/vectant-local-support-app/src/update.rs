use ed25519_dalek::{Signature, Verifier, VerifyingKey};
#[cfg(any(test, debug_assertions))]
use ed25519_dalek::{Signer, SigningKey};
#[cfg(any(test, debug_assertions))]
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub app_version: String,
    pub channel: String,
    pub artifact_sha256: String,
    pub minimum_supported_version: String,
    pub emergency_revoked_versions: Vec<String>,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    BadPublicKey,
    BadSignature,
    InvalidArtifactHash,
    InvalidVersion,
    UnsupportedChannel,
    Downgrade,
    VersionRevoked,
    UnsupportedCurrentVersion,
}

pub fn verify_update_manifest(
    trusted_public_key_hex: &str,
    current_version: &str,
    manifest: &UpdateManifest,
) -> Result<(), UpdateError> {
    if !valid_version(current_version)
        || !valid_version(&manifest.app_version)
        || !valid_version(&manifest.minimum_supported_version)
        || manifest
            .emergency_revoked_versions
            .iter()
            .any(|version| !valid_version(version))
    {
        return Err(UpdateError::InvalidVersion);
    }
    if manifest
        .emergency_revoked_versions
        .iter()
        .any(|version| version == current_version)
    {
        return Err(UpdateError::VersionRevoked);
    }
    if compare_versions(current_version, &manifest.minimum_supported_version) < 0 {
        return Err(UpdateError::UnsupportedCurrentVersion);
    }
    if compare_versions(&manifest.app_version, current_version) < 0 {
        return Err(UpdateError::Downgrade);
    }
    if !matches!(manifest.channel.as_str(), "stable" | "beta" | "internal") {
        return Err(UpdateError::UnsupportedChannel);
    }
    if !valid_sha256_digest(&manifest.artifact_sha256) {
        return Err(UpdateError::InvalidArtifactHash);
    }

    let public_key_bytes: [u8; 32] = hex::decode(trusted_public_key_hex)
        .map_err(|_| UpdateError::BadPublicKey)?
        .try_into()
        .map_err(|_| UpdateError::BadPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_key_bytes).map_err(|_| UpdateError::BadPublicKey)?;
    let signature_bytes: [u8; 64] = hex::decode(&manifest.signature)
        .map_err(|_| UpdateError::BadSignature)?
        .try_into()
        .map_err(|_| UpdateError::BadSignature)?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(&manifest_payload(manifest), &signature)
        .map_err(|_| UpdateError::BadSignature)
}

#[cfg(any(test, debug_assertions))]
pub fn signed_test_manifest(
    app_version: &str,
    current_minimum: &str,
    revoked_versions: Vec<String>,
) -> (String, UpdateManifest) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let mut manifest = UpdateManifest {
        app_version: app_version.to_string(),
        channel: "stable".to_string(),
        artifact_sha256: format!("sha256:{}", "a".repeat(64)),
        minimum_supported_version: current_minimum.to_string(),
        emergency_revoked_versions: revoked_versions,
        signature: String::new(),
    };
    manifest.signature = hex::encode(signing_key.sign(&manifest_payload(&manifest)).to_bytes());
    (hex::encode(signing_key.verifying_key().to_bytes()), manifest)
}

fn manifest_payload(manifest: &UpdateManifest) -> Vec<u8> {
    let revoked = manifest.emergency_revoked_versions.join(",");
    [
        "vectant-local-support-update-manifest-v1",
        &manifest.app_version,
        &manifest.channel,
        &manifest.artifact_sha256,
        &manifest.minimum_supported_version,
        &revoked,
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

fn valid_sha256_digest(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64 && digest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn valid_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    !parts.is_empty()
        && parts.len() <= 4
        && value.len() <= 32
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.len() <= 8 && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let left_parts = parse_version(left);
    let right_parts = parse_version(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_value = *left_parts.get(index).unwrap_or(&0);
        let right_value = *right_parts.get(index).unwrap_or(&0);
        if left_value > right_value {
            return 1;
        }
        if left_value < right_value {
            return -1;
        }
    }
    0
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}
