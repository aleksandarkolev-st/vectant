use std::collections::HashSet;
use std::time::{Duration, Instant};

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub workspace_id: String,
    pub token_fingerprint: String,
    pub paused: bool,
    pub protocol_version: String,
}

#[derive(Debug)]
pub struct SessionGuard {
    session_id: String,
    workspace_id: String,
    token: String,
    token_fingerprint: String,
    expires_at: Instant,
    paused: bool,
    seen_request_ids: HashSet<String>,
}

impl SessionGuard {
    pub fn new(workspace_id: impl Into<String>, ttl: Duration) -> Self {
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let token_fingerprint = fingerprint(&token);
        Self {
            session_id: format!("sess_{}", Uuid::new_v4()),
            workspace_id: workspace_id.into(),
            token,
            token_fingerprint,
            expires_at: Instant::now() + ttl,
            paused: false,
            seen_request_ids: HashSet::new(),
        }
    }

    pub fn token_for_pairing_response(&self) -> &str {
        &self.token
    }

    pub fn state(&self) -> SessionState {
        SessionState {
            session_id: self.session_id.clone(),
            workspace_id: self.workspace_id.clone(),
            token_fingerprint: self.token_fingerprint.clone(),
            paused: self.paused,
            protocol_version: crate::APP_PROTOCOL_VERSION.to_string(),
        }
    }

    pub fn validate(&mut self, token: &str, request_id: &str) -> Result<(), SessionError> {
        if self.paused {
            return Err(SessionError::Paused);
        }
        if Instant::now() > self.expires_at {
            return Err(SessionError::Expired);
        }
        if !constant_time_eq(token.as_bytes(), self.token.as_bytes()) {
            return Err(SessionError::BadToken);
        }
        if !self.seen_request_ids.insert(request_id.to_string()) {
            return Err(SessionError::Replay);
        }
        Ok(())
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn disconnect(&mut self) {
        self.expires_at = Instant::now();
        self.paused = true;
        self.seen_request_ids.clear();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    BadToken,
    Expired,
    Paused,
    Replay,
}

fn fingerprint(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("sha256:{}", hex::encode(&hasher.finalize()[..8]))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
