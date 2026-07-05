use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

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
    let header_list = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    if let Some(reason) = validate_preview_request_headers(&header_list) {
        return PreviewDecision::Deny(reason);
    }
    PreviewDecision::Allow
}

pub fn decide_preview_request_from_header_list(
    approval: Option<&PortApproval>,
    method: &str,
    host: &str,
    target_ip: IpAddr,
    headers: &[(&str, &str)],
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
    if let Some(reason) = validate_preview_request_headers(headers) {
        return PreviewDecision::Deny(reason);
    }
    PreviewDecision::Allow
}

pub fn validate_preview_request_headers(headers: &[(&str, &str)]) -> Option<String> {
    let mut content_length_count = 0usize;
    let mut has_transfer_encoding = false;
    let mut connection_tokens = Vec::new();
    let names = headers
        .iter()
        .map(|(name, _)| name.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();

    for (name, value) in headers {
        let lower = name.trim().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "cookie" | "authorization" | "proxy-authorization"
        ) {
            return Some("credential_header_blocked".to_string());
        }
        if lower == "content-length" {
            content_length_count += 1;
        }
        if lower == "transfer-encoding" {
            has_transfer_encoding = true;
        }
        if lower == "connection" {
            connection_tokens.extend(parse_connection_tokens(value));
        }
    }

    if content_length_count > 1 {
        return Some("duplicate_content_length_blocked".to_string());
    }
    if has_transfer_encoding && content_length_count > 0 {
        return Some("ambiguous_body_length_blocked".to_string());
    }
    if connection_tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "cookie" | "authorization" | "proxy-authorization" | "set-cookie"
        )
    }) {
        return Some("connection_sensitive_header_blocked".to_string());
    }
    if connection_tokens
        .iter()
        .any(|token| names.iter().any(|name| name == token))
    {
        return Some("connection_named_header_blocked".to_string());
    }
    None
}

pub fn sanitize_response_headers(headers: &HashMap<String, String>) -> HashMap<String, String> {
    let header_list = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    sanitize_response_header_list(&header_list)
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

pub fn sanitize_response_header_list(headers: &[(&str, &str)]) -> HashMap<String, String> {
    let mut sanitized = HashMap::new();
    let connection_tokens = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, value)| parse_connection_tokens(value))
        .collect::<Vec<_>>();

    for (name, value) in headers {
        let lower = name.trim().to_ascii_lowercase();
        if lower == "set-cookie"
            || lower == "content-security-policy-report-only"
            || HOP_BY_HOP_HEADERS.contains(&lower.as_str())
            || connection_tokens.iter().any(|token| token == &lower)
        {
            continue;
        }
        sanitized.insert(name.to_string(), value.to_string());
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
    let host = parse_host_without_port(host_part)?;
    let host_ip = match host {
        "localhost" => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "::1" => Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        value => value.parse::<IpAddr>().ok(),
    };
    Ok(ParsedUrl {
        scheme: scheme.to_ascii_lowercase(),
        host_ip,
        has_userinfo,
    })
}

fn parse_host_without_port(authority_host: &str) -> Result<&str, ()> {
    if let Some(rest) = authority_host.strip_prefix('[') {
        let end = rest.find(']').ok_or(())?;
        return Ok(&rest[..end]);
    }
    Ok(authority_host.split(':').next().ok_or(())?)
}

fn parse_connection_tokens(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn hash_process_identity(process_identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(process_identity.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}
