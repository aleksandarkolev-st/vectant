use std::collections::HashSet;
use std::time::{Duration, Instant};

use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub device_fingerprint: String,
    pub paused: bool,
    pub protocol_version: String,
    pub permission_mode: String,
    pub fast_support_remaining_seconds: u64,
}

pub struct DeviceProofContext<'a> {
    pub request_id: &'a str,
    pub account_id: &'a str,
    pub org_id: &'a str,
    pub workspace_id: &'a str,
    pub capability: &'a str,
    pub actor: &'a str,
    pub expires_at: &'a str,
    pub protocol_version: &'a str,
    pub policy_version: &'a str,
}

#[derive(Debug)]
pub struct SessionGuard {
    session_id: String,
    account_id: String,
    org_id: String,
    workspace_id: String,
    device_fingerprint: String,
    token: String,
    expires_at: Instant,
    paused: bool,
    fast_support_until: Option<Instant>,
    seen_request_ids: HashSet<String>,
}

impl SessionGuard {
    pub fn new_bound(
        account_id: impl Into<String>,
        org_id: impl Into<String>,
        workspace_id: impl Into<String>,
        ttl: Duration,
    ) -> Self {
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let device_fingerprint = fingerprint(&format!("device:{token}"));
        Self::new_bound_with_token(
            account_id,
            org_id,
            workspace_id,
            device_fingerprint,
            ttl,
            token,
        )
    }

    pub fn new_bound_device(
        account_id: impl Into<String>,
        org_id: impl Into<String>,
        workspace_id: impl Into<String>,
        device_fingerprint: impl Into<String>,
        ttl: Duration,
    ) -> Self {
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        Self::new_bound_with_token(
            account_id,
            org_id,
            workspace_id,
            device_fingerprint,
            ttl,
            token,
        )
    }

    pub fn new_paired(
        session_id: impl Into<String>,
        account_id: impl Into<String>,
        org_id: impl Into<String>,
        workspace_id: impl Into<String>,
        device_fingerprint: impl Into<String>,
        ttl: Duration,
    ) -> Result<Self, SessionError> {
        let session_id = session_id.into();
        if !session_id.starts_with("sess_") || !safe_request_id(&session_id) {
            return Err(SessionError::InvalidSessionId);
        }
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        Ok(Self::new_bound_with_session_and_token(
            session_id,
            account_id,
            org_id,
            workspace_id,
            device_fingerprint,
            ttl,
            token,
        ))
    }

    fn new_bound_with_token(
        account_id: impl Into<String>,
        org_id: impl Into<String>,
        workspace_id: impl Into<String>,
        device_fingerprint: impl Into<String>,
        ttl: Duration,
        token: String,
    ) -> Self {
        Self::new_bound_with_session_and_token(
            format!("sess_{}", Uuid::new_v4()),
            account_id,
            org_id,
            workspace_id,
            device_fingerprint,
            ttl,
            token,
        )
    }

    fn new_bound_with_session_and_token(
        session_id: String,
        account_id: impl Into<String>,
        org_id: impl Into<String>,
        workspace_id: impl Into<String>,
        device_fingerprint: impl Into<String>,
        ttl: Duration,
        token: String,
    ) -> Self {
        Self {
            session_id,
            account_id: account_id.into(),
            org_id: org_id.into(),
            workspace_id: workspace_id.into(),
            device_fingerprint: device_fingerprint.into(),
            token,
            expires_at: Instant::now() + ttl,
            paused: false,
            fast_support_until: None,
            seen_request_ids: HashSet::new(),
        }
    }

    pub fn token_for_pairing_response(&self) -> &str {
        &self.token
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn org_id(&self) -> &str {
        &self.org_id
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn device_fingerprint(&self) -> &str {
        &self.device_fingerprint
    }

    pub fn request_device_proof(&self, request_id: &str) -> String {
        self.request_device_proof_for_context(&DeviceProofContext {
            request_id,
            account_id: self.account_id.as_str(),
            org_id: self.org_id.as_str(),
            workspace_id: self.workspace_id.as_str(),
            capability: "",
            actor: "",
            expires_at: "",
            protocol_version: crate::APP_PROTOCOL_VERSION,
            policy_version: crate::POLICY_VERSION,
        })
    }

    pub fn request_device_proof_for_context(&self, context: &DeviceProofContext<'_>) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"vectant-local-support-device-proof-v1");
        hasher.update(b"\0");
        hasher.update(self.token.as_bytes());
        hasher.update(b"\0");
        hasher.update(self.session_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.request_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(self.device_fingerprint.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.account_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.org_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.workspace_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.capability.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.actor.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.expires_at.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.protocol_version.as_bytes());
        hasher.update(b"\0");
        hasher.update(context.policy_version.as_bytes());
        format!("sha256:{}", hex::encode(hasher.finalize()))
    }

    pub fn state(&self) -> SessionState {
        let fast_support_remaining_seconds = self
            .fast_support_until
            .map(|until| until.saturating_duration_since(Instant::now()).as_secs())
            .unwrap_or(0);
        SessionState {
            session_id: self.session_id.clone(),
            account_id: self.account_id.clone(),
            org_id: self.org_id.clone(),
            workspace_id: self.workspace_id.clone(),
            device_fingerprint: self.device_fingerprint.clone(),
            paused: self.paused,
            protocol_version: crate::APP_PROTOCOL_VERSION.to_string(),
            permission_mode: if fast_support_remaining_seconds > 0 {
                "Fast Support".to_string()
            } else {
                "Balanced mode".to_string()
            },
            fast_support_remaining_seconds,
        }
    }

    pub fn is_active(&self) -> bool {
        Instant::now() <= self.expires_at
    }

    pub fn remaining(&self) -> Duration {
        self.expires_at.saturating_duration_since(Instant::now())
    }

    pub fn renew(&mut self, ttl: Duration) -> Result<(), SessionError> {
        if !self.is_active() {
            return Err(SessionError::Expired);
        }
        self.expires_at = Instant::now() + ttl;
        Ok(())
    }

    pub fn validate(&mut self, token: &str, request_id: &str) -> Result<(), SessionError> {
        self.validate_inner(token, request_id, false)
    }

    pub fn validate_control(&mut self, token: &str, request_id: &str) -> Result<(), SessionError> {
        self.validate_inner(token, request_id, true)
    }

    fn validate_inner(
        &mut self,
        token: &str,
        request_id: &str,
        allow_paused: bool,
    ) -> Result<(), SessionError> {
        if Instant::now() > self.expires_at {
            return Err(SessionError::Expired);
        }
        if !constant_time_eq(token.as_bytes(), self.token.as_bytes()) {
            return Err(SessionError::BadToken);
        }
        if !safe_request_id(request_id) {
            return Err(SessionError::InvalidRequestId);
        }
        if self.paused && !allow_paused {
            return Err(SessionError::Paused);
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
        self.fast_support_until = None;
        self.seen_request_ids.clear();
    }

    pub fn set_fast_support(&mut self, enabled: bool) {
        self.fast_support_until = enabled.then(|| {
            let requested_until = Instant::now() + Duration::from_secs(30 * 60);
            requested_until.min(self.expires_at)
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    BadToken,
    Expired,
    Paused,
    Replay,
    InvalidRequestId,
    InvalidSessionId,
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

fn safe_request_id(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
}
