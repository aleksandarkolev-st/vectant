use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vectant_local_support_app::pair::DeviceIdentity;

const DEVICE_RELAY_PATH: &str = "/api/local-support/relay/device";
const DEVICE_PAYLOAD_PATH: &str = "/api/local-support/relay/device/payload";
const MAX_RELAY_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub enum RelayPoll {
    Idle,
    Delivery(Box<RelayDelivery>),
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelayDelivery {
    pub request_id: String,
    pub session_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub device_fingerprint: String,
    pub actor: String,
    pub capability: String,
    pub target_display: String,
    pub target_classification: String,
    pub scanner_version: String,
    pub policy_version: String,
    pub protocol_version: String,
    pub app_version: String,
    pub expires_at: String,
    pub lease_id: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct RelayOutcome<'a> {
    pub request_id: &'a str,
    pub lease_id: &'a str,
    pub decision: &'a str,
    pub bytes_sent: usize,
    pub redaction_count: usize,
    pub scanner_version: &'a str,
    pub reason: &'a str,
}

pub struct ApprovedRelayPayload<'a> {
    pub request_id: &'a str,
    pub content: &'a str,
    pub content_sha256: &'a str,
    pub redaction_count: usize,
    pub scanner_version: &'a str,
}

#[derive(Clone)]
pub struct RelayClient {
    endpoint: Url,
    origin: String,
    client: reqwest::Client,
}

impl RelayClient {
    pub fn from_environment() -> Result<Self, String> {
        let configured = std::env::var("VECTANT_LOCAL_SUPPORT_RELAY_URL").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "http://127.0.0.1:3000/api/local-support/relay/device".to_string()
            } else {
                "https://app.vectant.com/api/local-support/relay/device".to_string()
            }
        });
        Self::new(&configured)
    }

    pub fn new(endpoint: &str) -> Result<Self, String> {
        let endpoint = Url::parse(endpoint).map_err(|_| "Relay URL was invalid.".to_string())?;
        let loopback_http = endpoint.scheme() == "http"
            && matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
        if endpoint.scheme() != "https" && !(cfg!(debug_assertions) && loopback_http) {
            return Err("Relay URL must use HTTPS.".to_string());
        }
        if endpoint.path() != DEVICE_RELAY_PATH
            || endpoint.username() != ""
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(
                "Relay URL contained a forbidden path, credential, or parameter.".to_string(),
            );
        }
        let origin = endpoint.origin().ascii_serialization();
        let client = reqwest::Client::builder()
            .https_only(!loopback_http)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|_| "Relay client could not start.".to_string())?;
        Ok(Self {
            endpoint,
            origin,
            client,
        })
    }

    pub async fn poll(
        &self,
        identity: &DeviceIdentity,
        session_id: &str,
    ) -> Result<RelayPoll, String> {
        let body = serde_json::to_vec(&serde_json::json!({ "action": "poll" }))
            .map_err(|_| "Relay poll could not be serialized.".to_string())?;
        let value = self
            .post_signed(identity, session_id, DEVICE_RELAY_PATH, body)
            .await?;
        match value.get("decision").and_then(Value::as_str) {
            Some("relay_idle") => Ok(RelayPoll::Idle),
            Some("relay_delivery") => {
                let delivery: RelayDelivery =
                    serde_json::from_value(value.get("delivery").cloned().unwrap_or(Value::Null))
                        .map_err(|_| "Relay delivery was invalid.".to_string())?;
                delivery.validate()?;
                Ok(RelayPoll::Delivery(Box::new(delivery)))
            }
            _ => Err("Relay response was not accepted.".to_string()),
        }
    }

    pub async fn report_outcome(
        &self,
        identity: &DeviceIdentity,
        session_id: &str,
        outcome: &RelayOutcome<'_>,
    ) -> Result<(), String> {
        if !matches!(outcome.decision, "review_pending" | "denied" | "sent") {
            return Err("Relay outcome was invalid.".to_string());
        }
        let body = serde_json::to_vec(&serde_json::json!({
            "action": "outcome",
            "request_id": outcome.request_id,
            "lease_id": outcome.lease_id,
            "decision": outcome.decision,
            "bytes_sent": outcome.bytes_sent,
            "redaction_count": outcome.redaction_count,
            "scanner_version": outcome.scanner_version,
            "reason": outcome.reason,
        }))
        .map_err(|_| "Relay outcome could not be serialized.".to_string())?;
        let response = self
            .post_signed(identity, session_id, DEVICE_RELAY_PATH, body)
            .await?;
        if response.get("decision").and_then(Value::as_str) != Some(outcome.decision) {
            return Err("Relay outcome was not accepted.".to_string());
        }
        Ok(())
    }

    pub async fn upload_approved_payload(
        &self,
        identity: &DeviceIdentity,
        session_id: &str,
        payload: &ApprovedRelayPayload<'_>,
    ) -> Result<usize, String> {
        let body = serde_json::to_vec(&serde_json::json!({
            "action": "upload",
            "request_id": payload.request_id,
            "content": payload.content,
            "content_sha256": payload.content_sha256,
            "redaction_count": payload.redaction_count,
            "scanner_version": payload.scanner_version,
        }))
        .map_err(|_| "Approved payload could not be serialized.".to_string())?;
        if body.len() > 384 * 1024 {
            return Err("Approved payload exceeded the relay limit.".to_string());
        }
        let response = self
            .post_signed(identity, session_id, DEVICE_PAYLOAD_PATH, body)
            .await?;
        if response.get("decision").and_then(Value::as_str) != Some("sent") {
            return Err("Approved payload was not accepted.".to_string());
        }
        response
            .get("bytes_sent")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| "Approved payload receipt was invalid.".to_string())
    }

    pub async fn deny_reviewed_request(
        &self,
        identity: &DeviceIdentity,
        session_id: &str,
        request_id: &str,
    ) -> Result<(), String> {
        let body = serde_json::to_vec(&serde_json::json!({
            "action": "deny",
            "request_id": request_id,
            "reason": "local_user_denied",
        }))
        .map_err(|_| "Relay denial could not be serialized.".to_string())?;
        let response = self
            .post_signed(identity, session_id, DEVICE_PAYLOAD_PATH, body)
            .await?;
        if response.get("decision").and_then(Value::as_str) != Some("denied")
            || response.get("bytes_sent").and_then(Value::as_u64) != Some(0)
        {
            return Err("Relay denial was not accepted.".to_string());
        }
        Ok(())
    }

    async fn post_signed(
        &self,
        identity: &DeviceIdentity,
        session_id: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<Value, String> {
        let proof = identity.sign_device_request("POST", path, session_id, &body);
        let mut endpoint = self.endpoint.clone();
        endpoint.set_path(path);
        let response = self
            .client
            .post(endpoint)
            .header("Origin", &self.origin)
            .header("Sec-Fetch-Site", "same-origin")
            .header("Content-Type", "application/json")
            .header("X-Vectant-Session-Id", &proof.session_id)
            .header("X-Vectant-Device-Fingerprint", &proof.device_fingerprint)
            .header("X-Vectant-Device-Timestamp", &proof.timestamp)
            .header("X-Vectant-Device-Nonce", &proof.nonce)
            .header("X-Vectant-Body-Sha256", &proof.body_sha256)
            .header("X-Vectant-Device-Signature", &proof.signature)
            .body(body)
            .send()
            .await
            .map_err(|_| "Relay service could not be reached.".to_string())?;
        if !response.status().is_success() {
            return Err("Relay request was denied.".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Relay response could not be read.".to_string())?;
        if bytes.len() > MAX_RELAY_RESPONSE_BYTES {
            return Err("Relay response was too large.".to_string());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Relay response was invalid.".to_string())
    }
}

impl RelayDelivery {
    fn validate(&self) -> Result<(), String> {
        let identifiers = [
            &self.request_id,
            &self.session_id,
            &self.account_id,
            &self.org_id,
            &self.workspace_id,
            &self.actor,
            &self.capability,
        ];
        if identifiers.iter().any(|value| {
            value.len() < 3
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        }) || !self.device_fingerprint.starts_with("sha256:")
            || self.device_fingerprint.len() != 23
            || self.target_display.is_empty()
            || self.target_display.len() > 1024
            || self.target_classification.len() > 32
            || self.scanner_version.len() > 128
            || self.policy_version.len() > 128
            || self.protocol_version.len() > 128
            || self.app_version.len() > 64
            || !self
                .lease_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || self.lease_id.len() < 16
            || self.lease_id.len() > 64
            || self.signature.len() > 256
        {
            return Err("Relay delivery fields were invalid.".to_string());
        }
        chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map_err(|_| "Relay delivery expiry was invalid.".to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        body::Bytes,
        extract::{OriginalUri, State},
        http::HeaderMap,
        routing::post,
        Router,
    };
    use vectant_local_support_app::pair::{verify_device_request_proof, DeviceRequestProof};

    use super::*;

    #[tokio::test]
    async fn sends_a_body_bound_signature_over_a_real_socket() {
        let identity = DeviceIdentity::generate();
        let public_key = identity.public_identity().device_public_key;
        let verified = Arc::new(Mutex::new(false));
        let app = Router::new()
            .route(DEVICE_RELAY_PATH, post(verify_request))
            .route(DEVICE_PAYLOAD_PATH, post(verify_request))
            .with_state((public_key, verified.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = RelayClient::new(&format!(
            "http://127.0.0.1:{}/api/local-support/relay/device",
            address.port()
        ))
        .unwrap();
        let poll = client.poll(&identity, "sess_12345678").await.unwrap();
        client
            .report_outcome(
                &identity,
                "sess_12345678",
                &RelayOutcome {
                    request_id: "req_12345678",
                    lease_id: "11111111-1111-1111-1111-111111111111",
                    decision: "review_pending",
                    bytes_sent: 0,
                    redaction_count: 2,
                    scanner_version: "scanner-1",
                    reason: "local_review_required",
                },
            )
            .await
            .unwrap();
        let content_sha256 = format!("sha256:{}", "11".repeat(32));
        let bytes_sent = client
            .upload_approved_payload(
                &identity,
                "sess_12345678",
                &ApprovedRelayPayload {
                    request_id: "req_12345678",
                    content: "token=[REDACTED]",
                    content_sha256: &content_sha256,
                    redaction_count: 1,
                    scanner_version: "scanner-1",
                },
            )
            .await
            .unwrap();
        client
            .deny_reviewed_request(&identity, "sess_12345678", "req_12345678")
            .await
            .unwrap();

        assert!(matches!(poll, RelayPoll::Idle));
        assert_eq!(bytes_sent, 16);
        assert!(*verified.lock().unwrap());
    }

    async fn verify_request(
        State((public_key, verified)): State<(String, Arc<Mutex<bool>>)>,
        OriginalUri(uri): OriginalUri,
        headers: HeaderMap,
        body: Bytes,
    ) -> String {
        let proof = DeviceRequestProof {
            session_id: header(&headers, "x-vectant-session-id"),
            device_fingerprint: header(&headers, "x-vectant-device-fingerprint"),
            timestamp: header(&headers, "x-vectant-device-timestamp"),
            nonce: header(&headers, "x-vectant-device-nonce"),
            body_sha256: header(&headers, "x-vectant-body-sha256"),
            signature: header(&headers, "x-vectant-device-signature"),
        };
        *verified.lock().unwrap() =
            verify_device_request_proof(&proof, "POST", uri.path(), &body, &public_key);
        let body: Value = serde_json::from_slice(&body).unwrap();
        if body.get("action").and_then(Value::as_str) == Some("deny") {
            serde_json::json!({
                "decision": "denied",
                "raw_body_included": false,
                "bytes_sent": 0
            })
            .to_string()
        } else if body.get("action").and_then(Value::as_str) == Some("upload") {
            serde_json::json!({
                "decision": "sent",
                "raw_body_included": false,
                "bytes_sent": 16
            })
            .to_string()
        } else if body.get("action").and_then(Value::as_str) == Some("outcome") {
            serde_json::json!({
                "decision": body.get("decision").and_then(Value::as_str).unwrap(),
                "raw_body_included": false,
                "bytes_sent": 0
            })
            .to_string()
        } else {
            r#"{"decision":"relay_idle","raw_body_included":false,"bytes_sent":0}"#.to_string()
        }
    }

    fn header(headers: &HeaderMap, name: &str) -> String {
        headers.get(name).unwrap().to_str().unwrap().to_string()
    }
}
