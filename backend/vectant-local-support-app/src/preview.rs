use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use rand::{distributions::Alphanumeric, Rng};
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
    pub session_id: String,
    pub port: u16,
    pub target_host: String,
    pub preview_host: String,
    pub preview_token_hash: String,
    pub browser_preview_allowed: bool,
    pub agent_read_allowed: bool,
    pub support_agent_read_allowed: bool,
    pub agent_interact_allowed: bool,
    pub send_response_body_allowed: bool,
    pub send_screenshot_allowed: bool,
    pub send_console_errors_allowed: bool,
    pub state_changing_methods_allowed: bool,
    pub expires_at: String,
    pub persistent: bool,
    pub invalidate_on_port_close: bool,
    pub invalidate_on_process_change: bool,
    pub process_identity_hash: String,
}

impl PortApproval {
    pub fn browser_only(port: u16, process_identity: &str) -> Self {
        Self::browser_only_with_token(port, process_identity, &generate_preview_token())
    }

    pub fn browser_only_with_token(port: u16, process_identity: &str, preview_token: &str) -> Self {
        let process_identity_hash = hash_process_identity(process_identity);
        let preview_token_hash = hash_preview_token(preview_token);
        Self {
            session_id: "local-session".to_string(),
            port,
            target_host: "127.0.0.1".to_string(),
            preview_host: format!("br-local-p{port}.vectant-preview.dev"),
            preview_token_hash,
            browser_preview_allowed: true,
            agent_read_allowed: false,
            support_agent_read_allowed: false,
            agent_interact_allowed: false,
            send_response_body_allowed: false,
            send_screenshot_allowed: false,
            send_console_errors_allowed: false,
            state_changing_methods_allowed: false,
            expires_at: "session_end".to_string(),
            persistent: false,
            invalidate_on_port_close: true,
            invalidate_on_process_change: true,
            process_identity_hash,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PortApprovalGrant {
    pub approval: PortApproval,
    pub preview_token: String,
}

#[derive(Debug, Default)]
pub struct PortApprovalRegistry {
    approvals: HashMap<u16, PortApproval>,
}

impl PortApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn approve_browser_port(
        &mut self,
        session_id: impl Into<String>,
        port: u16,
        process_identity: &str,
    ) -> PortApproval {
        self.approve_browser_port_grant(session_id, port, process_identity)
            .approval
    }

    pub fn approve_browser_port_grant(
        &mut self,
        session_id: impl Into<String>,
        port: u16,
        process_identity: &str,
    ) -> PortApprovalGrant {
        let preview_token = generate_preview_token();
        let mut approval =
            PortApproval::browser_only_with_token(port, process_identity, &preview_token);
        approval.session_id = session_id.into();
        self.approvals.insert(port, approval.clone());
        PortApprovalGrant {
            approval,
            preview_token,
        }
    }

    pub fn approval_for(
        &self,
        session_id: &str,
        port: u16,
        process_identity: &str,
    ) -> Option<&PortApproval> {
        let approval = self.approvals.get(&port)?;
        if approval.session_id != session_id
            || approval.persistent
            || approval.expires_at != "session_end"
            || (approval.invalidate_on_process_change
                && !port_identity_matches(approval, process_identity))
        {
            return None;
        }
        Some(approval)
    }

    pub fn revoke_port(&mut self, port: u16) -> Option<PortApproval> {
        self.approvals.remove(&port)
    }

    pub fn approvals(&self) -> Vec<PortApproval> {
        self.approvals.values().cloned().collect()
    }

    pub fn disconnect_session(&mut self, session_id: &str) {
        self.approvals
            .retain(|_, approval| approval.session_id != session_id);
    }

    pub fn revoke_all(&mut self) {
        self.approvals.clear();
    }

    pub fn port_closed(&mut self, port: u16) {
        if self
            .approvals
            .get(&port)
            .is_some_and(|approval| approval.invalidate_on_port_close)
        {
            self.approvals.remove(&port);
        }
    }
}

pub fn port_identity_matches(approval: &PortApproval, current_process_identity: &str) -> bool {
    constant_time_eq(
        approval.process_identity_hash.as_bytes(),
        hash_process_identity(current_process_identity).as_bytes(),
    )
}

pub fn preview_token_matches(approval: &PortApproval, token: &str) -> bool {
    !token.is_empty()
        && constant_time_eq(
            approval.preview_token_hash.as_bytes(),
            hash_preview_token(token).as_bytes(),
        )
}

pub fn preview_path_allowed(path: &str) -> bool {
    let normalized = percent_decode_ascii(path.split('?').next().unwrap_or(path))
        .replace('\\', "/")
        .to_ascii_lowercase();
    !normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .any(is_blocked_worker_script_name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewDecision {
    Allow,
    Deny(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewRedirectDecision {
    RewriteToPreview(String),
    ExternalNavigation(String),
    Block(String),
}

pub fn decide_preview_request(
    approval: Option<&PortApproval>,
    method: &str,
    host: &str,
    target_ip: IpAddr,
    headers: &HashMap<String, String>,
) -> PreviewDecision {
    decide_preview_request_with_token(approval, method, host, target_ip, headers, "")
}

pub fn decide_preview_request_with_token(
    approval: Option<&PortApproval>,
    method: &str,
    host: &str,
    target_ip: IpAddr,
    headers: &HashMap<String, String>,
    preview_token: &str,
) -> PreviewDecision {
    let Some(approval) = approval else {
        return PreviewDecision::Deny("port_not_approved".to_string());
    };
    if !preview_token_matches(approval, preview_token) {
        return PreviewDecision::Deny("preview_token_invalid".to_string());
    }
    if !approval.browser_preview_allowed {
        return PreviewDecision::Deny("browser_preview_not_allowed".to_string());
    }
    if host != approval.preview_host {
        return PreviewDecision::Deny("preview_host_mismatch".to_string());
    }
    if !target_ip.is_loopback() {
        return PreviewDecision::Deny("target_not_loopback".to_string());
    }
    let Some(method) = normalize_preview_method(method) else {
        return PreviewDecision::Deny("invalid_method_blocked".to_string());
    };
    if !approval.state_changing_methods_allowed
        && !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS")
    {
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
    decide_preview_request_from_header_list_with_token(
        approval, method, host, target_ip, headers, "",
    )
}

pub fn decide_preview_request_from_header_list_with_token(
    approval: Option<&PortApproval>,
    method: &str,
    host: &str,
    target_ip: IpAddr,
    headers: &[(&str, &str)],
    preview_token: &str,
) -> PreviewDecision {
    let Some(approval) = approval else {
        return PreviewDecision::Deny("port_not_approved".to_string());
    };
    if !preview_token_matches(approval, preview_token) {
        return PreviewDecision::Deny("preview_token_invalid".to_string());
    }
    if !approval.browser_preview_allowed {
        return PreviewDecision::Deny("browser_preview_not_allowed".to_string());
    }
    if host != approval.preview_host {
        return PreviewDecision::Deny("preview_host_mismatch".to_string());
    }
    if !target_ip.is_loopback() {
        return PreviewDecision::Deny("target_not_loopback".to_string());
    }
    let Some(method) = normalize_preview_method(method) else {
        return PreviewDecision::Deny("invalid_method_blocked".to_string());
    };
    if !approval.state_changing_methods_allowed
        && !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS")
    {
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
            "cookie"
                | "authorization"
                | "proxy-authorization"
                | "x-api-key"
                | "x-auth-token"
                | "x-csrf-token"
                | "forwarded"
                | "x-forwarded-for"
                | "x-real-ip"
        ) {
            return Some("credential_header_blocked".to_string());
        }
        if lower == "upgrade" || lower.starts_with("sec-websocket-") {
            return Some("websocket_blocked".to_string());
        }
        if lower.starts_with("sec-") {
            return Some("browser_security_header_blocked".to_string());
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
            || lower == "clear-site-data"
            || lower == "content-security-policy"
            || lower == "x-frame-options"
            || lower == "cross-origin-opener-policy"
            || lower == "cross-origin-embedder-policy"
            || lower == "cross-origin-resource-policy"
            || lower == "alt-svc"
            || lower == "report-to"
            || lower == "nel"
            || lower == "link"
            || lower == "location"
            || lower == "refresh"
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
    sanitized.insert("Cache-Control".to_string(), "no-store".to_string());
    sanitized.insert("Referrer-Policy".to_string(), "no-referrer".to_string());
    sanitized.insert("X-Content-Type-Options".to_string(), "nosniff".to_string());
    sanitized.insert(
        "Permissions-Policy".to_string(),
        "geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), hid=()"
            .to_string(),
    );
    sanitized
}

pub const MAX_PREVIEW_REQUESTS_PER_MINUTE_PER_HOST: usize = 60;
pub const MAX_ACTIVE_PREVIEW_STREAMS_PER_HOST: usize = 4;
pub const MAX_PREVIEW_RESPONSE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct PreviewTrafficGuard {
    request_seconds_by_host: HashMap<String, Vec<u64>>,
    active_streams_by_host: HashMap<String, usize>,
}

impl PreviewTrafficGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allow_request_at(&mut self, preview_host: &str, now_epoch_seconds: u64) -> bool {
        let timestamps = self
            .request_seconds_by_host
            .entry(preview_host.to_string())
            .or_default();
        timestamps.retain(|timestamp| now_epoch_seconds.saturating_sub(*timestamp) < 60);
        if timestamps.len() >= MAX_PREVIEW_REQUESTS_PER_MINUTE_PER_HOST {
            return false;
        }
        timestamps.push(now_epoch_seconds);
        true
    }

    pub fn begin_stream(&mut self, preview_host: &str) -> bool {
        let active = self
            .active_streams_by_host
            .entry(preview_host.to_string())
            .or_default();
        if *active >= MAX_ACTIVE_PREVIEW_STREAMS_PER_HOST {
            return false;
        }
        *active += 1;
        true
    }

    pub fn end_stream(&mut self, preview_host: &str) {
        if let Some(active) = self.active_streams_by_host.get_mut(preview_host) {
            *active = active.saturating_sub(1);
        }
    }

    pub fn active_stream_count(&self, preview_host: &str) -> usize {
        self.active_streams_by_host
            .get(preview_host)
            .copied()
            .unwrap_or_default()
    }

    pub fn clear_all(&mut self) {
        self.request_seconds_by_host.clear();
        self.active_streams_by_host.clear();
    }
}

pub fn validate_preview_response_size(
    declared_content_length: Option<u64>,
    bytes_seen: u64,
) -> Result<(), String> {
    if declared_content_length.is_some_and(|length| length > MAX_PREVIEW_RESPONSE_BYTES) {
        return Err("preview_response_too_large".to_string());
    }
    if bytes_seen > MAX_PREVIEW_RESPONSE_BYTES {
        return Err("preview_response_too_large".to_string());
    }
    Ok(())
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

pub fn classify_preview_redirect(
    approval: &PortApproval,
    current_preview_path: &str,
    location: &str,
) -> PreviewRedirectDecision {
    let location = location.trim();
    if location.is_empty() || location.contains('\0') {
        return PreviewRedirectDecision::Block("invalid_redirect".to_string());
    }
    if location.starts_with('/') {
        return PreviewRedirectDecision::RewriteToPreview(location.to_string());
    }
    if !location.contains("://") {
        if location.contains(':') {
            return PreviewRedirectDecision::Block("custom_scheme_blocked".to_string());
        }
        return PreviewRedirectDecision::RewriteToPreview(resolve_relative_redirect_path(
            current_preview_path,
            location,
        ));
    }

    let Ok(url) = url_parse(location) else {
        return PreviewRedirectDecision::Block("invalid_redirect".to_string());
    };
    if url.has_userinfo {
        return PreviewRedirectDecision::Block("userinfo_blocked".to_string());
    }
    if !matches!(url.scheme.as_str(), "http" | "https") {
        return PreviewRedirectDecision::Block("custom_scheme_blocked".to_string());
    }
    if let Some(ip) = url.host_ip {
        if ip.is_loopback() && url.port == Some(approval.port) {
            return PreviewRedirectDecision::RewriteToPreview(url.path_and_query);
        }
        return PreviewRedirectDecision::Block("redirect_target_not_approved".to_string());
    }
    if url.scheme == "https" {
        return PreviewRedirectDecision::ExternalNavigation(location.to_string());
    }
    PreviewRedirectDecision::Block("redirect_target_not_loopback".to_string())
}

struct ParsedUrl {
    scheme: String,
    host_ip: Option<IpAddr>,
    port: Option<u16>,
    has_userinfo: bool,
    path_and_query: String,
}

fn url_parse(location: &str) -> Result<ParsedUrl, ()> {
    let (scheme, rest) = location.split_once("://").ok_or(())?;
    let (authority, path_and_query) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let has_userinfo = authority.contains('@');
    let host_part = authority.rsplit('@').next().ok_or(())?;
    let (host, port) = parse_host_and_port(host_part)?;
    if host_has_forbidden_numeric_form(host) {
        return Err(());
    }
    let host_lower = host.to_ascii_lowercase();
    let host_ip = match host {
        _ if host_lower == "localhost" => Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        "::1" => Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        value => value.parse::<IpAddr>().ok(),
    };
    Ok(ParsedUrl {
        scheme: scheme.to_ascii_lowercase(),
        host_ip,
        port,
        has_userinfo,
        path_and_query: path_and_query.to_string(),
    })
}

fn parse_host_and_port(authority_host: &str) -> Result<(&str, Option<u16>), ()> {
    if let Some(rest) = authority_host.strip_prefix('[') {
        let end = rest.find(']').ok_or(())?;
        let remainder = &rest[end + 1..];
        let port = parse_optional_port(remainder)?;
        return Ok((&rest[..end], port));
    }
    let mut parts = authority_host.split(':');
    let host = parts.next().ok_or(())?;
    let port = match parts.next() {
        Some(value) => Some(value.parse::<u16>().map_err(|_| ())?),
        None => None,
    };
    if parts.next().is_some() {
        return Err(());
    }
    Ok((host, port))
}

fn parse_optional_port(remainder: &str) -> Result<Option<u16>, ()> {
    if remainder.is_empty() {
        return Ok(None);
    }
    let value = remainder.strip_prefix(':').ok_or(())?;
    Ok(Some(value.parse::<u16>().map_err(|_| ())?))
}

fn host_has_forbidden_numeric_form(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower.starts_with("0x")
        || lower.split('.').any(|part| part.starts_with("0x"))
        || lower.split('.').any(|part| {
            part.len() > 1 && part.starts_with('0') && part.chars().all(|ch| ch.is_ascii_digit())
        })
        || (lower.chars().all(|ch| ch.is_ascii_digit()) && lower.len() > 3)
}

fn resolve_relative_redirect_path(current_preview_path: &str, location: &str) -> String {
    let base = current_preview_path.split('?').next().unwrap_or("/");
    let directory = match base.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &base[..=index],
    };
    format!("{directory}{location}")
}

fn parse_connection_tokens(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn normalize_preview_method(method: &str) -> Option<String> {
    let trimmed = method.trim();
    if trimmed.is_empty()
        || trimmed.len() > 16
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphabetic() || ch == '-')
    {
        return None;
    }
    Some(trimmed.to_ascii_uppercase())
}

fn is_blocked_worker_script_name(segment: &str) -> bool {
    matches!(
        segment,
        "sw.js" | "service-worker.js" | "serviceworker.js" | "worker.js"
    )
}

fn percent_decode_ascii(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = String::with_capacity(value.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push(char::from((high << 4) | low));
                index += 3;
                continue;
            }
        }
        decoded.push(char::from(bytes[index]));
        index += 1;
    }
    decoded
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn hash_process_identity(process_identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(process_identity.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_preview_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-preview-token:");
    hasher.update(token.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn generate_preview_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
