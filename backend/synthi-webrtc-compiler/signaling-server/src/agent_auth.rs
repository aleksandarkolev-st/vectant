//! Phase 4 — scoped agent-token verification + TURN credential minting.
//!
//! When `SYNTHI_AGENT_TOKEN_SECRET` is set the signaling-server will
//! verify a JWT-ish signed token on any `register` with `role:"mcp-agent"`
//! (and optionally other roles — see `verify_agent_token`). The secret
//! is never exposed on the wire; it lives in the server's env alongside
//! an out-of-band token issuer (e.g. a collab-server route, or the
//! `scripts/issue-agent-token.mjs` helper in the MCP package).
//!
//! When `SYNTHI_TURN_URL` + `SYNTHI_TURN_SECRET` are set we mint short-
//! lived TURN REST credentials (coturn's `use-auth-secret` flow,
//! draft-uberti-behave-turn-rest-00) and return them on the `registered`
//! ack so the MCP can plug them directly into its `RTCIceServer` list
//! without a separate trip.
//!
//! Both subsystems are opt-in and default off — deployments without
//! TURN or with an upstream auth layer continue to work unchanged.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

/// Claims the signaling-server requires on an agent token. Matches the
/// subset of JWT we need — we don't bring in a full JWT crate because
/// the only algorithm we support is HS256 with these exact claims.
#[derive(Debug, Clone, Deserialize)]
struct AgentTokenClaims {
    /// Stable agent identifier. Surfaces in operator event logs.
    sub: String,
    /// Scope string — must equal `"mcp-agent"`. Rejecting other values
    /// stops a user-scoped token (minted for frontend auth) from being
    /// reused for backend agent access.
    scope: String,
    /// Session the token is bound to. Rejecting a mismatch keeps an
    /// agent from leaking its own token to observe a different session.
    session_id: String,
    /// Role the token was minted for. Defaults to `"mcp-agent"` when
    /// omitted for forward-compat.
    #[serde(default)]
    role: Option<String>,
    /// Unix-seconds expiry. Enforced with a 60s grace to absorb modest
    /// clock skew between issuer + verifier.
    exp: u64,
    /// Unix-seconds issued-at. Informational; never rejected.
    #[serde(default)]
    iat: Option<u64>,
}

/// Token-verification outcome. Callers pattern-match so the register
/// path can choose to reject vs. degrade vs. pass.
#[derive(Debug, PartialEq, Eq)]
pub enum AgentTokenOutcome {
    /// No secret configured — auth disabled. Register proceeds
    /// unauthenticated (preserves backwards-compat).
    Disabled,
    /// Secret configured + token missing or role doesn't need a token.
    /// Register proceeds without a verified identity.
    Unauthenticated,
    /// Token verified. Claims surfaced for logging / scoping.
    Authenticated {
        subject: String,
        session_id: String,
        role: String,
    },
    /// Token supplied but failed verification. Caller should respond
    /// with a `register-error` and break the connection.
    Rejected { code: &'static str },
}

/// Verify a register envelope carrying role `mcp-agent`.
///
/// Policy: if `SYNTHI_AGENT_TOKEN_SECRET` is unset we return `Disabled`
/// — every deployment today is local-dev or behind an upstream auth
/// layer. When set we require every `mcp-agent` register to carry a
/// signed token that matches the requested session + role.
///
/// Non-agent roles (`browser`, `worker`, `observer`, `operator`) are
/// untouched — the signaling-server is not the right place to enforce
/// frontend / worker auth.
pub fn verify_agent_token(
    secret: Option<&str>,
    role: &str,
    session_id: &str,
    token: Option<&str>,
) -> AgentTokenOutcome {
    let Some(secret) = secret else {
        return AgentTokenOutcome::Disabled;
    };
    if role != "mcp-agent" {
        return AgentTokenOutcome::Unauthenticated;
    }
    let Some(token) = token else {
        return AgentTokenOutcome::Rejected { code: "agent_token_required" };
    };

    let claims = match verify_hs256(token, secret.as_bytes()) {
        Ok(c) => c,
        Err(code) => return AgentTokenOutcome::Rejected { code },
    };

    if claims.scope != "mcp-agent" {
        return AgentTokenOutcome::Rejected { code: "agent_token_wrong_scope" };
    }
    if claims.session_id != session_id {
        return AgentTokenOutcome::Rejected { code: "agent_token_session_mismatch" };
    }
    if let Some(claim_role) = claims.role.as_deref() {
        if claim_role != role {
            return AgentTokenOutcome::Rejected { code: "agent_token_role_mismatch" };
        }
    }

    AgentTokenOutcome::Authenticated {
        subject: claims.sub,
        session_id: claims.session_id,
        role: role.to_string(),
    }
}

/// HS256 JWT verification over `header.payload.signature`. Returns the
/// decoded claims on success or a stable error code suitable for a
/// `register-error` envelope.
fn verify_hs256(token: &str, secret: &[u8]) -> Result<AgentTokenClaims, &'static str> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("agent_token_malformed");
    }
    let signing_input = format!("{}.{}", parts[0], parts[1]);

    let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| "agent_token_malformed")?;
    let header_json: serde_json::Value =
        serde_json::from_slice(&header_bytes).map_err(|_| "agent_token_malformed")?;
    let alg = header_json
        .get("alg")
        .and_then(|v| v.as_str())
        .ok_or("agent_token_malformed")?;
    if alg != "HS256" {
        return Err("agent_token_unsupported_alg");
    }

    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "agent_token_malformed")?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| "agent_token_bad_secret")?;
    mac.update(signing_input.as_bytes());
    mac.verify_slice(&sig)
        .map_err(|_| "agent_token_bad_signature")?;

    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "agent_token_malformed")?;
    let claims: AgentTokenClaims =
        serde_json::from_slice(&payload).map_err(|_| "agent_token_malformed")?;

    let now = now_secs();
    // 60s grace for modest clock skew between issuer + verifier.
    if claims.exp + 60 < now {
        return Err("agent_token_expired");
    }

    Ok(claims)
}

/// Mint an HS256 JWT with the claims the MCP is expected to present on
/// register. Exposed for unit tests + any future in-process issuer
/// (e.g. a signaling `POST /issue-agent-token` admin route).
pub fn issue_hs256(
    secret: &[u8],
    subject: &str,
    session_id: &str,
    role: &str,
    ttl_seconds: u64,
) -> String {
    let iat = now_secs();
    let exp = iat + ttl_seconds;
    let header = serde_json::json!({"alg":"HS256","typ":"JWT"});
    let payload = serde_json::json!({
        "sub": subject,
        "scope": "mcp-agent",
        "session_id": session_id,
        "role": role,
        "iat": iat,
        "exp": exp,
    });
    let header_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&header).expect("stable json"));
    let payload_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).expect("stable json"));
    let signing_input = format!("{header_b64}.{payload_b64}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key");
    mac.update(signing_input.as_bytes());
    let sig = mac.finalize().into_bytes();
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig);
    format!("{signing_input}.{sig_b64}")
}

/// Short-lived TURN credential. coturn's `use-auth-secret` mode expects
/// the username to carry a Unix-seconds expiry prefix; the password is
/// `base64(HMAC-SHA1(secret, username))`. We return all three so the MCP
/// can plug the values straight into `RTCIceServer` without knowing the
/// secret.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TurnCredentials {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    /// Unix seconds — agents set a refresh timer off this if they want
    /// to rotate before re-offering.
    pub expires_at: u64,
}

/// Mint TURN credentials. `subject` is mixed into the username so
/// per-agent leaks are traceable in the TURN server's audit log. Returns
/// `None` when the TURN env vars aren't configured; callers then skip
/// the `turn_credentials` field on the register ack.
pub fn mint_turn_credentials(
    secret: Option<&str>,
    urls: Option<&str>,
    subject: &str,
    ttl_seconds: u64,
) -> Option<TurnCredentials> {
    let secret = secret?;
    let urls_raw = urls?;
    // The env var is comma-separated so deployments can list `turn:…` and
    // `turns:…` together; TURN REST credentials work against either.
    let urls: Vec<String> = urls_raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if urls.is_empty() {
        return None;
    }

    let expires_at = now_secs() + ttl_seconds;
    // Username format `<expiry>:<subject>` matches coturn's `use-auth-secret` doc.
    let username = format!("{expires_at}:{subject}");
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(username.as_bytes());
    let sig = mac.finalize().into_bytes();
    let credential = base64::engine::general_purpose::STANDARD.encode(sig);

    Some(TurnCredentials {
        urls,
        username,
        credential,
        expires_at,
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-32-bytes-or-thereabouts";

    #[test]
    fn disabled_when_secret_missing() {
        let out = verify_agent_token(None, "mcp-agent", "sid", Some("anything"));
        assert_eq!(out, AgentTokenOutcome::Disabled);
    }

    #[test]
    fn unauth_for_non_agent_role_even_when_configured() {
        let out = verify_agent_token(Some("x"), "browser", "sid", None);
        assert_eq!(out, AgentTokenOutcome::Unauthenticated);
    }

    #[test]
    fn rejects_missing_token_for_agent() {
        let out = verify_agent_token(Some("x"), "mcp-agent", "sid", None);
        assert!(matches!(
            out,
            AgentTokenOutcome::Rejected { code: "agent_token_required" }
        ));
    }

    #[test]
    fn rejects_malformed_token() {
        let out = verify_agent_token(Some("x"), "mcp-agent", "sid", Some("not.a.jwt"));
        assert!(matches!(
            out,
            AgentTokenOutcome::Rejected { code: "agent_token_malformed" | "agent_token_bad_signature" }
        ));
    }

    #[test]
    fn roundtrip_issue_then_verify() {
        let token = issue_hs256(SECRET, "agent-1", "sess-42", "mcp-agent", 300);
        let out = verify_agent_token(
            Some(std::str::from_utf8(SECRET).unwrap()),
            "mcp-agent",
            "sess-42",
            Some(&token),
        );
        match out {
            AgentTokenOutcome::Authenticated { subject, session_id, role } => {
                assert_eq!(subject, "agent-1");
                assert_eq!(session_id, "sess-42");
                assert_eq!(role, "mcp-agent");
            }
            other => panic!("expected Authenticated, got {other:?}"),
        }
    }

    #[test]
    fn rejects_session_mismatch() {
        let token = issue_hs256(SECRET, "agent-1", "sess-A", "mcp-agent", 300);
        let out = verify_agent_token(
            Some(std::str::from_utf8(SECRET).unwrap()),
            "mcp-agent",
            "sess-B",
            Some(&token),
        );
        assert!(matches!(
            out,
            AgentTokenOutcome::Rejected { code: "agent_token_session_mismatch" }
        ));
    }

    #[test]
    fn rejects_wrong_scope() {
        // Craft a token with scope:"user" using the same HS256 signing.
        let header = serde_json::json!({"alg":"HS256","typ":"JWT"});
        let payload = serde_json::json!({
            "sub":"u1","scope":"user","session_id":"sid","role":"mcp-agent",
            "iat":now_secs(),"exp":now_secs()+300,
        });
        let enc = |v: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(v).unwrap())
        };
        let signing = format!("{}.{}", enc(&header), enc(&payload));
        let mut mac = HmacSha256::new_from_slice(SECRET).unwrap();
        mac.update(signing.as_bytes());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(mac.finalize().into_bytes());
        let token = format!("{signing}.{sig}");
        let out = verify_agent_token(
            Some(std::str::from_utf8(SECRET).unwrap()),
            "mcp-agent",
            "sid",
            Some(&token),
        );
        assert!(matches!(
            out,
            AgentTokenOutcome::Rejected { code: "agent_token_wrong_scope" }
        ));
    }

    #[test]
    fn rejects_expired_token() {
        let header = serde_json::json!({"alg":"HS256","typ":"JWT"});
        let payload = serde_json::json!({
            "sub":"u1","scope":"mcp-agent","session_id":"sid","role":"mcp-agent",
            "iat":now_secs()-3600,"exp":now_secs()-300,
        });
        let enc = |v: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(v).unwrap())
        };
        let signing = format!("{}.{}", enc(&header), enc(&payload));
        let mut mac = HmacSha256::new_from_slice(SECRET).unwrap();
        mac.update(signing.as_bytes());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(mac.finalize().into_bytes());
        let token = format!("{signing}.{sig}");
        let out = verify_agent_token(
            Some(std::str::from_utf8(SECRET).unwrap()),
            "mcp-agent",
            "sid",
            Some(&token),
        );
        assert!(matches!(
            out,
            AgentTokenOutcome::Rejected { code: "agent_token_expired" }
        ));
    }

    #[test]
    fn turn_creds_none_without_env() {
        assert!(mint_turn_credentials(None, Some("turn:host"), "a", 3600).is_none());
        assert!(mint_turn_credentials(Some("s"), None, "a", 3600).is_none());
        assert!(mint_turn_credentials(Some("s"), Some(""), "a", 3600).is_none());
    }

    #[test]
    fn turn_creds_format_matches_use_auth_secret() {
        let creds = mint_turn_credentials(
            Some("turn-secret"),
            Some("turn:turn.example:3478?transport=udp,turns:turn.example:5349"),
            "agent-7",
            3600,
        )
        .expect("creds");
        assert_eq!(creds.urls.len(), 2);
        assert!(creds.username.ends_with(":agent-7"));
        assert!(creds.credential.len() > 20, "credential should be base64 hmac");
        // Re-derive + compare so the format stays load-bearing.
        let mut mac = HmacSha1::new_from_slice(b"turn-secret").unwrap();
        mac.update(creds.username.as_bytes());
        let expected =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(creds.credential, expected);
    }
}
