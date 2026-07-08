use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::policy::{Classification, DecisionKind, PolicyDecision};
use crate::scanner::{ScanReport, SecretScanner};

const MAX_FILE_BYTES: u64 = 262_144;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadRequest {
    pub request_id: String,
    pub session_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub device_fingerprint: String,
    pub capability: String,
    pub path: String,
    pub max_bytes: Option<u64>,
    pub reason: String,
    pub actor: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadResponse {
    pub request_id: String,
    pub approval_id: Option<String>,
    pub decision: String,
    pub path_display: String,
    pub classification: Classification,
    pub bytes_sent: usize,
    pub content_sha256: Option<String>,
    pub redactions: Vec<String>,
    pub scanner_version: String,
    pub policy_version: String,
    pub user_visible_message: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub workspace_id: String,
    pub display: String,
    pub root_hash: String,
    pub root_path_included: bool,
    pub policy_version: String,
    pub scanner_version: String,
}

#[derive(Debug, Clone)]
pub struct WorkspacePolicy {
    root: PathBuf,
    workspace_id: String,
    scanner: SecretScanner,
}

impl WorkspacePolicy {
    pub fn new(root: impl AsRef<Path>, workspace_id: impl Into<String>, scanner: SecretScanner) -> Result<Self> {
        let root = root.as_ref().canonicalize().context("workspace root must exist")?;
        if !root.is_dir() {
            return Err(anyhow!("workspace root must be a directory"));
        }
        Ok(Self {
            root,
            workspace_id: workspace_id.into(),
            scanner,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn root_display(&self) -> String {
        self.root.display().to_string()
    }

    pub fn summary(&self) -> WorkspaceSummary {
        let display = self
            .root
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Selected workspace")
            .to_string();
        let mut hasher = Sha256::new();
        hasher.update(b"vectant-local-support-workspace-root:");
        hasher.update(self.root.to_string_lossy().as_bytes());
        WorkspaceSummary {
            workspace_id: self.workspace_id.clone(),
            display,
            root_hash: format!("sha256:{}", hex::encode(hasher.finalize())),
            root_path_included: false,
            policy_version: crate::POLICY_VERSION.to_string(),
            scanner_version: crate::SCANNER_VERSION.to_string(),
        }
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn decide_file(&self, request: &FileReadRequest) -> PolicyDecision {
        if request.workspace_id != self.workspace_id {
            return PolicyDecision::deny("workspace_mismatch", Classification::L5);
        }
        if request.capability != "workspace.file.source.read" && request.capability != "workspace.log.read" {
            return PolicyDecision::deny("capability_not_allowed", Classification::L5);
        }
        if request.actor != "vectant_ai" && request.actor != "support_agent" {
            return PolicyDecision::deny("actor_not_allowed", Classification::L5);
        }
        if is_sensitive_path(&request.path) {
            return PolicyDecision::deny("blocked_secret_file_pattern", Classification::L4);
        }
        if is_archive_path(&request.path) {
            return PolicyDecision::deny("archive_file_blocked", Classification::L4);
        }
        if resolve_relative(&self.root, &request.path).is_err() {
            return PolicyDecision::deny("path_outside_workspace", Classification::L5);
        }
        PolicyDecision::approval(
            "source_file_requires_review",
            Classification::L2,
            format!("Review {} before sending to Vectant.", request.path),
        )
    }

    pub fn read_file_for_review(&self, request: &FileReadRequest) -> FileReadResponse {
        let policy = self.decide_file(request);
        if matches!(&policy.decision, DecisionKind::Deny) {
            return self.denied_response(request, policy);
        }

        match self.safe_read_text(&request.path, request.max_bytes.unwrap_or(MAX_FILE_BYTES)) {
            Ok((content, sha)) => {
                let path_display = self.scrub_display(&request.path);
                let scan = match self.scanner.try_scan(&content) {
                    Ok(scan) => scan,
                    Err(_) => {
                        return FileReadResponse {
                            request_id: request.request_id.clone(),
                            approval_id: None,
                            decision: "denied".to_string(),
                            path_display: path_display.clone(),
                            classification: Classification::L5,
                            bytes_sent: 0,
                            content_sha256: None,
                            redactions: Vec::new(),
                            scanner_version: crate::SCANNER_VERSION.to_string(),
                            policy_version: crate::POLICY_VERSION.to_string(),
                            user_visible_message: Some(
                                "Blocked because the local secret scanner was unavailable. Nothing was sent."
                                    .to_string(),
                            ),
                            content: None,
                        };
                    }
                };
                if !scan.findings.is_empty() {
                    let redacted = self.scanner.redact(&content, &scan);
                    return FileReadResponse {
                        request_id: request.request_id.clone(),
                        approval_id: None,
                        decision: "redact_then_approval".to_string(),
                        path_display: path_display.clone(),
                        classification: scan.classification,
                        bytes_sent: redacted.len(),
                        content_sha256: Some(sha),
                        redactions: scan.findings.into_iter().map(|f| f.kind).collect(),
                        scanner_version: scan.scanner_version,
                        policy_version: crate::POLICY_VERSION.to_string(),
                        user_visible_message: Some("Possible secrets were redacted locally. Review before sending.".to_string()),
                        content: Some(redacted),
                    };
                }

                FileReadResponse {
                    request_id: request.request_id.clone(),
                    approval_id: None,
                    decision: "approval_required".to_string(),
                    path_display,
                    classification: scan.classification,
                    bytes_sent: content.len(),
                    content_sha256: Some(sha),
                    redactions: Vec::new(),
                    scanner_version: scan.scanner_version,
                    policy_version: crate::POLICY_VERSION.to_string(),
                    user_visible_message: Some("No secrets detected. Review before sending.".to_string()),
                    content: Some(content),
                }
            }
            Err(error) => FileReadResponse {
                request_id: request.request_id.clone(),
                approval_id: None,
                decision: "denied".to_string(),
                path_display: self.scrub_display(&request.path),
                classification: Classification::L5,
                bytes_sent: 0,
                content_sha256: None,
                redactions: Vec::new(),
                scanner_version: crate::SCANNER_VERSION.to_string(),
                policy_version: crate::POLICY_VERSION.to_string(),
                user_visible_message: Some(format!("Blocked because the local app could not safely read this file: {error}")),
                content: None,
            },
        }
    }

    fn denied_response(
        &self,
        request: &FileReadRequest,
        decision: PolicyDecision,
    ) -> FileReadResponse {
        let classification = decision.classification;
        let reason = decision.reason;
        let path_display = self.scrub_display(&request.path);
        FileReadResponse {
            request_id: request.request_id.clone(),
            approval_id: None,
            decision: "denied".to_string(),
            path_display: path_display.clone(),
            classification,
            bytes_sent: 0,
            content_sha256: None,
            redactions: Vec::new(),
            scanner_version: crate::SCANNER_VERSION.to_string(),
            policy_version: crate::POLICY_VERSION.to_string(),
            user_visible_message: Some(match reason.as_str() {
                "blocked_secret_file_pattern" => format!(
                    "Blocked {path_display}. This file usually contains secrets. Nothing was sent."
                ),
                _ => format!("Blocked {path_display}: {reason}. Nothing was sent."),
            }),
            content: None,
        }
    }

    fn scrub_display(&self, value: &str) -> String {
        let report = self.scanner.scan(value);
        self.scanner.redact(value, &report)
    }

    fn safe_read_text(&self, requested_path: &str, max_bytes: u64) -> Result<(String, String)> {
        let resolved = resolve_relative(&self.root, requested_path)?;
        let before = fs::metadata(&resolved).context("metadata before open failed")?;
        if !before.is_file() {
            return Err(anyhow!("not a regular file"));
        }
        if before.len() > max_bytes.min(MAX_FILE_BYTES) {
            return Err(anyhow!("file exceeds size cap"));
        }
        if is_sparse_metadata(&before) {
            return Err(anyhow!("sparse file blocked"));
        }

        let mut file = File::open(&resolved).context("open failed")?;
        let after = file.metadata().context("metadata after open failed")?;
        if !same_file_identity(&before, &after) {
            return Err(anyhow!("file changed during open"));
        }
        if is_sparse_metadata(&after) {
            return Err(anyhow!("sparse file blocked"));
        }

        let mut bytes = Vec::with_capacity(before.len() as usize);
        file.read_to_end(&mut bytes).context("read failed")?;
        let after_read = file.metadata().context("metadata after read failed")?;
        if !same_file_identity(&before, &after_read) || is_sparse_metadata(&after_read) {
            return Err(anyhow!("file changed during read"));
        }
        if bytes.contains(&0) {
            return Err(anyhow!("binary file blocked"));
        }
        let content = String::from_utf8(bytes).context("invalid utf-8 blocked")?;
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        let sha = format!("sha256:{}", hex::encode(hasher.finalize()));
        Ok((content, sha))
    }
}

pub fn resolve_relative(root: &Path, requested_path: &str) -> Result<PathBuf> {
    if requested_path.contains('\0') {
        return Err(anyhow!("nul byte blocked"));
    }
    if has_forbidden_path_prefix(requested_path) {
        return Err(anyhow!("device or network path blocked"));
    }
    let path = Path::new(requested_path);
    if path.is_absolute() {
        return Err(anyhow!("absolute path blocked"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(anyhow!("path traversal blocked")),
        }
    }
    let joined = root.join(path);
    let canonical = joined.canonicalize().context("target must exist inside workspace")?;
    if !is_within(root, &canonical) {
        return Err(anyhow!("canonical target escaped workspace"));
    }
    Ok(canonical)
}

fn has_forbidden_path_prefix(requested_path: &str) -> bool {
    let normalized = requested_path.replace('/', "\\").to_ascii_lowercase();
    normalized.starts_with("\\\\")
        || normalized.starts_with("\\??\\")
        || normalized.starts_with("\\\\.\\")
        || normalized.starts_with("\\\\?\\")
        || normalized.starts_with("\\\\.\\pipe\\")
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':')
}

fn is_within(root: &Path, target: &Path) -> bool {
    if cfg!(windows) {
        let root = root.to_string_lossy().to_lowercase();
        let target = target.to_string_lossy().to_lowercase();
        target == root || target.starts_with(&(root + std::path::MAIN_SEPARATOR_STR))
    } else {
        target.starts_with(root)
    }
}

fn is_sensitive_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    normalized.starts_with(".ssh/")
        || normalized.starts_with(".aws/")
        || normalized.starts_with(".gcp/")
        || normalized.starts_with(".azure/")
        || normalized.starts_with(".kube/")
        || normalized.starts_with(".docker/")
        || normalized.starts_with(".git/objects/")
        || normalized.starts_with(".git/logs/")
        || normalized.starts_with(".git/hooks/")
        || normalized.starts_with("node_modules/")
        || normalized.starts_with("vendor/")
        || normalized.starts_with("dist/")
        || normalized.starts_with("build/")
        || normalized.starts_with(".next/")
        || normalized.starts_with(".nuxt/")
        || normalized.starts_with("coverage/")
        || normalized.contains("/.ssh/")
        || normalized.contains("/.aws/")
        || normalized.contains("/.gcp/")
        || normalized.contains("/.azure/")
        || normalized.contains("/.kube/")
        || normalized.contains("/.docker/")
        || normalized.contains("/.git/objects/")
        || normalized.contains("/.git/logs/")
        || normalized.contains("/.git/hooks/")
        || normalized.contains("/node_modules/")
        || normalized.contains("/vendor/")
        || normalized.contains("/dist/")
        || normalized.contains("/build/")
        || normalized.contains("/.next/")
        || normalized.contains("/.nuxt/")
        || normalized.contains("/coverage/")
        || normalized == ".git/config"
        || normalized.ends_with("/.git/config")
        || normalized == ".vscode/settings.json"
        || normalized.ends_with("/.vscode/settings.json")
        || name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".env")
        || name.contains(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".crt")
        || name.ends_with(".cer")
        || name.ends_with(".der")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name == "id_ecdsa"
        || name == "known_hosts"
        || name == ".npmrc"
        || name == ".pypirc"
        || name == ".netrc"
        || name == ".git-credentials"
        || name == ".ds_store"
        || name == "thumbs.db"
        || name == "package-lock.json"
        || name == "pnpm-lock.yaml"
        || name == "yarn.lock"
        || name == "bun.lockb"
        || name == "composer.lock"
        || name == "poetry.lock"
        || name == "cargo.lock"
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || name.ends_with(".sqlite")
        || name.ends_with(".db")
        || name.ends_with(".dump")
        || name.ends_with(".bak")
        || name.ends_with(".sql")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
}

fn is_archive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".zip", ".tar", ".tgz", ".gz", ".7z", ".rar", ".bz2", ".xz"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

#[cfg(unix)]
fn same_file_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && same_modified_time(a, b)
}

#[cfg(windows)]
fn same_file_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    a.file_index() == b.file_index()
        && a.volume_serial_number() == b.volume_serial_number()
        && a.file_size() == b.file_size()
        && same_modified_time(a, b)
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && same_modified_time(a, b)
}

#[cfg(unix)]
fn is_sparse_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.len() > 0 && metadata.blocks().saturating_mul(512) < metadata.len()
}

#[cfg(windows)]
fn is_sparse_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x0000_0200;
    metadata.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE != 0
}

#[cfg(not(any(unix, windows)))]
fn is_sparse_metadata(_metadata: &fs::Metadata) -> bool {
    false
}

fn same_modified_time(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.modified().ok() == b.modified().ok()
}

pub fn scan_for_secrets(content: &str) -> ScanReport {
    SecretScanner::default().scan(content)
}
