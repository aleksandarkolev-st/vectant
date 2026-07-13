use chrono::{DateTime, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_PAIRING_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_POLICY_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ClaimedPairing {
    #[serde(skip_serializing)]
    pub code: String,
    pub pairing_id: String,
    pub fingerprint: String,
    pub server_nonce: String,
    pub browser_session_id: String,
    pub requested_user_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompletedPairing {
    pub session_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub device_fingerprint: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopPolicyStatus {
    pub available: bool,
    pub enabled: bool,
    pub pairing_disabled: bool,
    pub preview_disabled: bool,
    pub agent_access_disabled: bool,
    pub update_required: bool,
    pub current_version: String,
    pub minimum_version: String,
    pub vulnerable_versions: Vec<String>,
    pub retention_days: u16,
    pub reason: String,
    pub user_visible_message: String,
}

impl DesktopPolicyStatus {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            enabled: false,
            pairing_disabled: true,
            preview_disabled: true,
            agent_access_disabled: true,
            update_required: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            minimum_version: "unknown".to_string(),
            vulnerable_versions: Vec::new(),
            retention_days: 30,
            reason: "policy_unavailable".to_string(),
            user_visible_message:
                "Cloud policy is unavailable. New pairing is disabled until it can be checked."
                    .to_string(),
        }
    }

    pub fn pairing_allowed(&self) -> bool {
        self.available && self.enabled && !self.pairing_disabled && !self.update_required
    }

    pub fn preview_allowed(&self) -> bool {
        self.available && self.enabled && !self.preview_disabled
    }

    pub fn update_version_allowed(&self, version: &str) -> bool {
        self.available
            && valid_numeric_version(version)
            && compare_numeric_versions(version, &self.current_version) >= std::cmp::Ordering::Equal
            && compare_numeric_versions(version, &self.minimum_version) >= std::cmp::Ordering::Equal
            && !self
                .vulnerable_versions
                .iter()
                .any(|blocked| blocked == version)
    }
}

#[derive(Clone)]
pub struct PairingClient {
    endpoint: Url,
    origin: String,
    client: reqwest::Client,
}

impl PairingClient {
    pub fn from_environment() -> Result<Self, String> {
        let configured = std::env::var("VECTANT_LOCAL_SUPPORT_PAIRING_URL").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "http://127.0.0.1:3000/api/local-support/pairing".to_string()
            } else {
                "https://app.vectant.com/api/local-support/pairing".to_string()
            }
        });
        Self::new(&configured)
    }

    pub fn new(endpoint: &str) -> Result<Self, String> {
        let endpoint = Url::parse(endpoint).map_err(|_| "Pairing URL was invalid.".to_string())?;
        let loopback_http = endpoint.scheme() == "http"
            && matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
        if endpoint.scheme() != "https" && !(cfg!(debug_assertions) && loopback_http) {
            return Err("Pairing URL must use HTTPS.".to_string());
        }
        if endpoint.username() != ""
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("Pairing URL contained forbidden credentials or parameters.".to_string());
        }
        let origin = endpoint.origin().ascii_serialization();
        let client = reqwest::Client::builder()
            .https_only(!loopback_http)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| "Pairing client could not start.".to_string())?;
        Ok(Self {
            endpoint,
            origin,
            client,
        })
    }

    pub async fn claim(&self, code: &str, workspace_id: &str) -> Result<ClaimedPairing, String> {
        if !valid_pairing_code(code) || !safe_identifier(workspace_id) {
            return Err("Pairing code or workspace identifier was invalid.".to_string());
        }
        let value = self
            .post(serde_json::json!({
                "action": "claim",
                "code": code,
                "workspace_id": workspace_id,
                "app_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": vectant_local_support_app::APP_PROTOCOL_VERSION,
            }))
            .await?;
        parse_claimed_pairing(value, code)
    }

    pub async fn complete(
        &self,
        claim: &ClaimedPairing,
        proof: &vectant_local_support_app::pair::PairingProof,
    ) -> Result<CompletedPairing, String> {
        let value = self
            .post(serde_json::json!({
                "action": "complete",
                "pairing_id": claim.pairing_id,
                "code": claim.code,
                "fingerprint": claim.fingerprint,
                "proof": proof,
            }))
            .await?;
        parse_completed_pairing(value)
    }

    pub async fn policy(&self) -> Result<DesktopPolicyStatus, String> {
        let mut endpoint = self.endpoint.clone();
        endpoint.set_path("/api/local-support/policy");
        let response = self
            .client
            .get(endpoint)
            .header("Origin", &self.origin)
            .header("Sec-Fetch-Site", "same-origin")
            .send()
            .await
            .map_err(|_| "Local Support policy could not be reached.".to_string())?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Local Support policy could not be read.".to_string())?;
        if bytes.len() > MAX_POLICY_RESPONSE_BYTES {
            return Err("Local Support policy response was too large.".to_string());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Local Support policy response was invalid.".to_string())?;
        if !status.is_success() {
            return Err("Local Support policy is unavailable.".to_string());
        }
        parse_policy_status(value, env!("CARGO_PKG_VERSION"))
    }

    async fn post(&self, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .header("Origin", &self.origin)
            .header("Sec-Fetch-Site", "same-origin")
            .json(&body)
            .send()
            .await
            .map_err(|_| "Pairing service could not be reached.".to_string())?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Pairing response could not be read.".to_string())?;
        if bytes.len() > MAX_PAIRING_RESPONSE_BYTES {
            return Err("Pairing response was too large.".to_string());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Pairing response was invalid.".to_string())?;
        if !status.is_success() || value.get("decision").and_then(Value::as_str) == Some("denied") {
            return Err(pairing_denial_message(
                value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ));
        }
        Ok(value)
    }
}

pub fn parse_policy_status(
    value: Value,
    current_version: &str,
) -> Result<DesktopPolicyStatus, String> {
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Local Support policy omitted its enabled state.".to_string())?;
    let minimum_version = value
        .get("min_app_version")
        .and_then(Value::as_str)
        .ok_or_else(|| "Local Support policy omitted its minimum version.".to_string())?;
    if !valid_numeric_version(current_version) || !valid_numeric_version(minimum_version) {
        return Err("Local Support policy contained an invalid version.".to_string());
    }
    let vulnerable_versions = value
        .get("vulnerable_versions")
        .and_then(Value::as_array)
        .ok_or_else(|| "Local Support policy omitted its vulnerable versions.".to_string())?;
    if vulnerable_versions.len() > 100
        || vulnerable_versions.iter().any(|version| {
            version
                .as_str()
                .is_none_or(|version| !valid_numeric_version(version))
        })
    {
        return Err("Local Support policy contained invalid vulnerable versions.".to_string());
    }
    let pairing_disabled = value
        .pointer("/emergency_controls/pairing_disabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let preview_disabled = value
        .pointer("/emergency_controls/preview_gateway_disabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let agent_access_disabled = value
        .pointer("/emergency_controls/agent_access_disabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let vulnerable_versions = vulnerable_versions
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let vulnerable = vulnerable_versions
        .iter()
        .any(|version| version == current_version);
    let retention_days = match value.pointer("/retention/cloud_security_event_days") {
        None => 30,
        Some(value) => value
            .as_u64()
            .filter(|days| *days <= 90)
            .and_then(|days| u16::try_from(days).ok())
            .ok_or_else(|| "Local Support policy contained invalid retention days.".to_string())?,
    };
    let too_old = compare_numeric_versions(current_version, minimum_version).is_lt();
    let update_required = vulnerable || too_old;
    let reason = if vulnerable {
        "version_vulnerable"
    } else if too_old {
        "version_too_old"
    } else if !enabled {
        "feature_disabled"
    } else if pairing_disabled {
        "pairing_disabled"
    } else {
        "policy_current"
    };
    let default_message = if update_required {
        "This Local Support version is blocked. Install a signed update before pairing."
    } else if !enabled || pairing_disabled {
        "Local Support pairing is disabled by organization policy."
    } else {
        "This Local Support version satisfies current policy."
    };
    let message = value
        .get("user_visible_message")
        .and_then(Value::as_str)
        .filter(|message| {
            !message.is_empty()
                && message.len() <= 240
                && !message
                    .chars()
                    .any(|character| matches!(character, '\r' | '\n'))
        })
        .unwrap_or(default_message);
    Ok(DesktopPolicyStatus {
        available: true,
        enabled,
        pairing_disabled,
        preview_disabled,
        agent_access_disabled,
        update_required,
        current_version: current_version.to_string(),
        minimum_version: minimum_version.to_string(),
        vulnerable_versions,
        retention_days,
        reason: reason.to_string(),
        user_visible_message: message.to_string(),
    })
}

fn valid_numeric_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && value.len() <= 32
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 8 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn compare_numeric_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(u32::MAX))
        .collect::<Vec<_>>();
    let right = right
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(u32::MAX))
        .collect::<Vec<_>>();
    for index in 0..left.len().max(right.len()) {
        match left
            .get(index)
            .unwrap_or(&0)
            .cmp(right.get(index).unwrap_or(&0))
        {
            std::cmp::Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
}

fn pairing_denial_message(reason: &str) -> String {
    match reason {
        "pairing_challenge_not_found" => "Pairing code was not found or has expired.",
        "pairing_code_expired" => "Pairing code has expired. Start a new challenge in the browser.",
        "pairing_code_consumed" => "Pairing code was already used.",
        "pairing_rate_limited" => "Too many pairing attempts. Try again later.",
        "workspace_mismatch" => "Pairing challenge is for a different workspace.",
        "feature_disabled" => "Local Support pairing is disabled by policy.",
        "account_mismatch" | "org_mismatch" => {
            "Pairing challenge belongs to a different account or organization."
        }
        "app_version_too_old" => "Update required before pairing can continue.",
        _ => "Pairing request was denied.",
    }
    .to_string()
}

pub fn parse_claimed_pairing(value: Value, code: &str) -> Result<ClaimedPairing, String> {
    if value.get("decision").and_then(Value::as_str) != Some("pairing_challenge_claimed") {
        return Err("Pairing claim response was not accepted.".to_string());
    }
    let claim = ClaimedPairing {
        code: code.to_string(),
        pairing_id: required(&value, "pairing_id")?,
        fingerprint: required(&value, "fingerprint")?,
        server_nonce: required(&value, "server_nonce")?,
        browser_session_id: required(&value, "browser_session_id")?,
        requested_user_id: required(&value, "requested_user_id")?,
        account_id: required(&value, "account_id")?,
        org_id: required(&value, "org_id")?,
        workspace_id: required(&value, "workspace_id")?,
        expires_at: required(&value, "expires_at")?,
    };
    if !valid_pairing_code(&claim.code)
        || !valid_fingerprint(&claim.fingerprint)
        || !safe_identifier(&claim.pairing_id)
        || !safe_identifier(&claim.browser_session_id)
        || !safe_identifier(&claim.requested_user_id)
        || !safe_identifier(&claim.account_id)
        || !safe_identifier(&claim.org_id)
        || !safe_identifier(&claim.workspace_id)
        || !future_expiry(&claim.expires_at)
    {
        return Err("Pairing claim fields were invalid or expired.".to_string());
    }
    Ok(claim)
}

pub fn parse_completed_pairing(value: Value) -> Result<CompletedPairing, String> {
    if value.get("decision").and_then(Value::as_str) != Some("pairing_complete") {
        return Err("Pairing completion response was not accepted.".to_string());
    }
    let completed: CompletedPairing = serde_json::from_value(value)
        .map_err(|_| "Pairing completion fields were invalid.".to_string())?;
    if !safe_identifier(&completed.session_id)
        || !completed.session_id.starts_with("sess_")
        || !safe_identifier(&completed.account_id)
        || !safe_identifier(&completed.org_id)
        || !safe_identifier(&completed.workspace_id)
        || !valid_device_fingerprint(&completed.device_fingerprint)
        || !future_expiry(&completed.expires_at)
    {
        return Err("Pairing completion fields were invalid or expired.".to_string());
    }
    Ok(completed)
}

fn required(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= 256)
        .map(str::to_string)
        .ok_or_else(|| "Pairing response omitted a required field.".to_string())
}

fn valid_pairing_code(value: &str) -> bool {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    value.len() == 12 && value.bytes().all(|byte| ALPHABET.contains(&byte))
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 14
        && value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 9) && byte == b'-'
                || !matches!(index, 4 | 9) && byte.is_ascii_hexdigit()
        })
}

fn valid_device_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 16 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn future_expiry(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|expiry| expiry.with_timezone(&Utc) > Utc::now())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{Arc, Mutex};
    use vectant_local_support_app::pair::{verify_pairing_proof, DeviceIdentity, PairingProof};

    fn future() -> String {
        (Utc::now() + chrono::Duration::minutes(2)).to_rfc3339()
    }

    #[test]
    fn validates_pairing_urls_and_claim_payloads() {
        assert!(PairingClient::new("https://app.vectant.com/api/local-support/pairing").is_ok());
        assert!(PairingClient::new("http://example.com/pairing").is_err());
        assert!(PairingClient::new("https://user:pass@app.vectant.com/pairing").is_err());
        let claim = parse_claimed_pairing(
            serde_json::json!({
                "decision": "pairing_challenge_claimed",
                "pairing_id": "pair_12345678",
                "fingerprint": "1a2b-3c4d-5e6f",
                "server_nonce": "nonce_12345678",
                "browser_session_id": "browser_12345678",
                "requested_user_id": "user_12345678",
                "account_id": "acct_12345678",
                "org_id": "org_12345678",
                "workspace_id": "wk_12345678",
                "expires_at": future(),
            }),
            "ABCD2345WXYZ",
        )
        .unwrap();
        assert_eq!(claim.workspace_id, "wk_12345678");
        assert!(!serde_json::to_string(&claim)
            .unwrap()
            .contains("ABCD2345WXYZ"));
    }

    #[test]
    fn rejects_expired_or_malformed_pairing_responses() {
        assert!(parse_claimed_pairing(
            serde_json::json!({
                "decision": "pairing_challenge_claimed",
                "pairing_id": "pair_12345678",
                "fingerprint": "not-a-fingerprint",
                "server_nonce": "nonce_12345678",
                "browser_session_id": "browser_12345678",
                "requested_user_id": "user_12345678",
                "account_id": "acct_12345678",
                "org_id": "org_12345678",
                "workspace_id": "wk_12345678",
                "expires_at": future(),
            }),
            "ABCD2345WXYZ",
        )
        .is_err());
        assert_eq!(
            pairing_denial_message("unknown_with_secret_abc"),
            "Pairing request was denied."
        );
        assert!(parse_completed_pairing(serde_json::json!({
            "decision": "pairing_complete",
            "session_id": "sess_12345678",
            "account_id": "acct_12345678",
            "org_id": "org_12345678",
            "workspace_id": "wk_12345678",
            "device_fingerprint": "sha256:1111111111111111",
            "expires_at": "2020-01-01T00:00:00Z",
        }))
        .is_err());
    }

    #[test]
    fn evaluates_live_version_and_pairing_policy_fail_closed() {
        let current = parse_policy_status(
            serde_json::json!({
                "enabled": true,
                "min_app_version": "0.1.0",
                "vulnerable_versions": [],
                "emergency_controls": {
                    "pairing_disabled": false,
                    "preview_gateway_disabled": false,
                    "agent_access_disabled": true
                },
            }),
            "0.1.0",
        )
        .unwrap();
        assert!(current.pairing_allowed());
        assert!(!current.preview_disabled);
        assert!(current.agent_access_disabled);
        assert!(current.preview_allowed());
        assert_eq!(current.reason, "policy_current");

        let old = parse_policy_status(
            serde_json::json!({
                "enabled": true,
                "min_app_version": "0.2.0",
                "vulnerable_versions": [],
                "emergency_controls": { "pairing_disabled": false },
            }),
            "0.1.9",
        )
        .unwrap();
        assert!(old.update_required);
        assert!(!old.pairing_allowed());
        assert!(!old.update_version_allowed("0.1.5"));
        assert!(old.update_version_allowed("0.2.0"));
        assert_eq!(old.reason, "version_too_old");

        let vulnerable = parse_policy_status(
            serde_json::json!({
                "enabled": true,
                "min_app_version": "0.1.0",
                "vulnerable_versions": ["0.1.1"],
                "retention": { "cloud_security_event_days": 7 },
                "emergency_controls": { "pairing_disabled": false },
            }),
            "0.1.1",
        )
        .unwrap();
        assert_eq!(vulnerable.reason, "version_vulnerable");
        assert_eq!(vulnerable.retention_days, 7);
        assert!(!vulnerable.update_version_allowed("0.1.1"));
        assert!(vulnerable.update_version_allowed("0.2.0"));

        let disabled = parse_policy_status(
            serde_json::json!({
                "enabled": false,
                "min_app_version": "0.1.0",
                "vulnerable_versions": [],
                "emergency_controls": { "pairing_disabled": true },
            }),
            "0.1.0",
        )
        .unwrap();
        assert!(!disabled.pairing_allowed());
        assert_eq!(disabled.reason, "feature_disabled");

        let unavailable = DesktopPolicyStatus::unavailable();
        assert!(!unavailable.update_version_allowed("99.0.0"));

        assert!(parse_policy_status(
            serde_json::json!({
                "enabled": true,
                "min_app_version": "latest",
                "vulnerable_versions": [],
            }),
            "0.1.0"
        )
        .is_err());
        assert!(parse_policy_status(
            serde_json::json!({
                "enabled": true,
                "min_app_version": "0.1.0",
                "vulnerable_versions": [],
                "retention": { "cloud_security_event_days": 91 },
            }),
            "0.1.0"
        )
        .is_err());
        assert!(!DesktopPolicyStatus::unavailable().pairing_allowed());
        assert!(!DesktopPolicyStatus::unavailable().preview_allowed());
    }

    #[tokio::test]
    async fn fetches_bounded_policy_over_a_real_loopback_connection() {
        let app = Router::new().route(
            "/api/local-support/policy",
            get(|| async {
                Json(serde_json::json!({
                    "enabled": true,
                    "min_app_version": "0.1.0",
                    "vulnerable_versions": [],
                    "emergency_controls": { "pairing_disabled": false },
                    "user_visible_message": "Local Support is available.",
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            PairingClient::new(&format!("http://{address}/api/local-support/pairing")).unwrap();

        let policy = client.policy().await.unwrap();

        assert!(policy.available);
        assert!(policy.pairing_allowed());
        assert_eq!(policy.user_visible_message, "Local Support is available.");
    }

    #[tokio::test]
    async fn rejects_oversized_policy_from_a_real_loopback_connection() {
        let app = Router::new().route(
            "/api/local-support/policy",
            get(|| async { "x".repeat(MAX_POLICY_RESPONSE_BYTES + 1) }),
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            PairingClient::new(&format!("http://{address}/api/local-support/pairing")).unwrap();

        assert_eq!(
            client.policy().await.unwrap_err(),
            "Local Support policy response was too large."
        );
    }

    #[tokio::test]
    async fn claims_and_completes_pairing_over_a_real_loopback_connection() {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let app = Router::new()
            .route(
                "/api/local-support/pairing",
                post(|State(requests): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>| async move {
                    requests.lock().unwrap().push(body.clone());
                    if body["action"] == "claim" {
                        return Json(serde_json::json!({
                            "decision": "pairing_challenge_claimed",
                            "pairing_id": "pair_12345678",
                            "fingerprint": "1a2b-3c4d-5e6f",
                            "server_nonce": "nonce_12345678",
                            "browser_session_id": "browser_12345678",
                            "requested_user_id": "user_12345678",
                            "account_id": "acct_12345678",
                            "org_id": "org_12345678",
                            "workspace_id": "wk_12345678",
                            "expires_at": (Utc::now() + chrono::Duration::minutes(2)).to_rfc3339(),
                        }));
                    }
                    let proof: PairingProof = serde_json::from_value(body["proof"].clone()).unwrap();
                    verify_pairing_proof(&proof).unwrap();
                    Json(serde_json::json!({
                        "decision": "pairing_complete",
                        "session_id": "sess_12345678",
                        "account_id": "acct_12345678",
                        "org_id": "org_12345678",
                        "workspace_id": "wk_12345678",
                        "device_fingerprint": proof.device_fingerprint,
                        "expires_at": (Utc::now() + chrono::Duration::minutes(2)).to_rfc3339(),
                    }))
                }),
            )
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client =
            PairingClient::new(&format!("http://{address}/api/local-support/pairing")).unwrap();

        let claim = client.claim("ABCD2345WXYZ", "wk_12345678").await.unwrap();
        let identity = DeviceIdentity::generate();
        let proof = identity.sign_pairing_challenge(
            &claim.pairing_id,
            &claim.server_nonce,
            &claim.browser_session_id,
            &claim.requested_user_id,
        );
        let completed = client.complete(&claim, &proof).await.unwrap();

        assert_eq!(completed.session_id, "sess_12345678");
        assert_eq!(
            completed.device_fingerprint,
            identity.public_identity().device_fingerprint
        );
        let captured = requests.lock().unwrap();
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[0]["workspace_id"], "wk_12345678");
        assert_eq!(
            captured[1]["proof"]["device_public_key"],
            proof.device_public_key
        );
    }
}
