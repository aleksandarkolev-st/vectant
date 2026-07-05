use std::time::{Duration, Instant};

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    pub fingerprint: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug)]
pub struct PairingSession {
    code: String,
    fingerprint: String,
    expires_at: Instant,
    attempts: u8,
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
        if Instant::now() > self.expires_at {
            return Err(PairingError::Expired);
        }
        if submitted_code != self.code || submitted_fingerprint != self.fingerprint {
            return Err(PairingError::Mismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    Expired,
    Mismatch,
    RateLimited,
}

fn pairing_fingerprint(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-pairing:");
    hasher.update(code.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{}-{}-{}", &digest[0..4], &digest[4..8], &digest[8..12])
}
