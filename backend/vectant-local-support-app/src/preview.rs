use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortApproval {
    pub port: u16,
    pub target_host: String,
    pub preview_host: String,
    pub browser_preview_allowed: bool,
    pub agent_read_allowed: bool,
    pub support_agent_read_allowed: bool,
    pub agent_interact_allowed: bool,
    pub send_response_body_allowed: bool,
    pub state_changing_methods_allowed: bool,
    pub expires_at: String,
    pub process_identity_hash: String,
}

impl PortApproval {
    pub fn browser_only(port: u16, process_identity: &str) -> Self {
        let process_identity_hash = hash_process_identity(process_identity);
        Self {
            port,
            target_host: "127.0.0.1".to_string(),
            preview_host: format!("br-local-p{port}.vectant-preview.dev"),
            browser_preview_allowed: true,
            agent_read_allowed: false,
            support_agent_read_allowed: false,
            agent_interact_allowed: false,
            send_response_body_allowed: false,
            state_changing_methods_allowed: false,
            expires_at: "session_end".to_string(),
            process_identity_hash,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewDecision {
    Allow,
    Deny(String),
}

pub fn decide_preview_request(
    approval: Option<&PortApproval>,
    method: &str,
    host: &str,
    target_ip: IpAddr,
    headers: &HashMap<String, String>,
) -> PreviewDecision {
    let Some(approval) = approval else {
        return PreviewDecision::Deny("port_not_approved".to_string());
    };
    if !approval.browser_preview_allowed {
        return PreviewDecision::Deny("browser_preview_not_allowed".to_string());
    }
    if host != approval.preview_host {
        return PreviewDecision::Deny("preview_host_mismatch".to_string());
    }
    if !target_ip.is_loopback() {
        return PreviewDecision::Deny("target_not_loopback".to_string());
    }
    if !approval.state_changing_methods_allowed && !matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return PreviewDecision::Deny("state_changing_method_blocked".to_string());
    }
    if headers.keys().any(|name| {
        let lower = name.to_ascii_lowercase();
        lower == "cookie" || lower == "authorization" || lower == "proxy-authorization"
    }) {
        return PreviewDecision::Deny("credential_header_blocked".to_string());
    }
    PreviewDecision::Allow
}

pub fn sanitize_response_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let mut sanitized = HashMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "set-cookie" | "connection" | "transfer-encoding" | "content-security-policy-report-only"
        ) {
            continue;
        }
        sanitized.insert(name.clone(), value.clone());
    }
    sanitized.insert(
        "Content-Security-Policy".to_string(),
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; worker-src 'none'".to_string(),
    );
    sanitized.insert("Service-Worker-Allowed".to_string(), "none".to_string());
    sanitized
}

pub fn redirect_allowed(location: &str) -> bool {
    let Ok(url) = url_parse(location) else {
        return false;
    };
    if !matches!(url.scheme.as_str(), "http" | "https") {
        return false;
    }
    if url.has_userinfo {
        return false;
    }
    match url.host_ip {
        Some(ip) => ip.is_loopback(),
        None => false,
    }
}

struct ParsedUrl {
    scheme: String,
    host_ip: Option<IpAddr>,
    has_userinfo: bool,
}

fn url_parse(location: &str) -> Result<ParsedUrl, ()> {
    let (scheme, rest) = location.split_once("://").ok_or(())?;
    let authority = rest.split('/').next().ok_or(())?;
    let has_userinfo = authority.contains('@');
    let host_part = authority.rsplit('@').next().ok_or(())?;
    let host = host_part.split(':').next().ok_or(())?;
    let host_ip = match host {
        "localhost" => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "::1" | "[::1]" => Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        value => value.parse::<IpAddr>().ok(),
    };
    Ok(ParsedUrl {
        scheme: scheme.to_ascii_lowercase(),
        host_ip,
        has_userinfo,
    })
}

fn hash_process_identity(process_identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(process_identity.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}
