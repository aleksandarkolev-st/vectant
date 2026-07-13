use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::policy::Classification;
use crate::scanner::SecretScanner;

const AUDIT_EXPORT_VERSION: &str = "local-support-audit-v1";
const MAX_AUDIT_STORE_BYTES: u64 = 2 * 1024 * 1024;
const ZERO_HASH: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditClass {
    Control,
    Data,
    Denied,
    Redaction,
    Preview,
    Security,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub at: DateTime<Utc>,
    pub class: AuditClass,
    pub request_id: Option<String>,
    pub summary: String,
    pub user_visible: bool,
    pub previous_hash: String,
    pub event_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentReceipt {
    pub approval_id: String,
    pub request_id: String,
    pub session_id: String,
    pub account_id: String,
    pub org_id: String,
    pub workspace_id: String,
    pub device_fingerprint: String,
    pub actor: String,
    pub capability: String,
    pub target_display: String,
    pub classification: Classification,
    pub content_sha256: Option<String>,
    pub scope: String,
    pub granted_at: DateTime<Utc>,
    pub expires_at: String,
    pub policy_version: String,
    pub scanner_version: String,
    #[serde(default)]
    pub bytes_sent: usize,
    #[serde(default)]
    pub redaction_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditExport {
    pub export_version: String,
    pub exported_at: DateTime<Utc>,
    pub raw_bodies_included: bool,
    pub retention_days: u16,
    pub events: Vec<AuditEvent>,
    pub consent_receipts: Vec<ConsentReceipt>,
    pub root_hash: String,
}

#[derive(Debug, Clone, Default)]
pub struct AuditLog {
    events: Vec<AuditEvent>,
    consent_receipts: Vec<ConsentReceipt>,
    scanner: SecretScanner,
}

impl AuditLog {
    pub fn new(scanner: SecretScanner) -> Self {
        Self {
            events: Vec::new(),
            consent_receipts: Vec::new(),
            scanner,
        }
    }

    pub fn append(
        &mut self,
        class: AuditClass,
        request_id: Option<String>,
        summary: impl AsRef<str>,
        user_visible: bool,
    ) {
        self.append_at(class, request_id, summary, user_visible, Utc::now());
    }

    pub fn append_at(
        &mut self,
        class: AuditClass,
        request_id: Option<String>,
        summary: impl AsRef<str>,
        user_visible: bool,
        at: DateTime<Utc>,
    ) {
        let report = self.scanner.scan(summary.as_ref());
        let scrubbed = self.scanner.redact(summary.as_ref(), &report);
        let previous_hash = self
            .events
            .last()
            .map(|event| event.event_hash.clone())
            .unwrap_or_else(|| ZERO_HASH.to_string());
        let event_hash = hash_event(
            &at,
            &class,
            request_id.as_deref(),
            &scrubbed,
            user_visible,
            &previous_hash,
        );
        self.events.push(AuditEvent {
            at,
            class,
            request_id,
            summary: scrubbed,
            user_visible,
            previous_hash,
            event_hash,
        });
    }

    pub fn record_consent(&mut self, receipt: ConsentReceipt) {
        self.record_consent_at(receipt.clone(), receipt.granted_at);
    }

    pub fn record_consent_at(&mut self, mut receipt: ConsentReceipt, at: DateTime<Utc>) {
        let report = self.scanner.scan(&receipt.target_display);
        receipt.target_display = self.scanner.redact(&receipt.target_display, &report);
        self.append_at(
            AuditClass::Control,
            Some(receipt.request_id.clone()),
            format!(
                "Consent {} granted for {} by {} on {}.",
                receipt.approval_id, receipt.capability, receipt.actor, receipt.target_display
            ),
            true,
            at,
        );
        self.consent_receipts.push(receipt);
    }

    pub fn events(&self) -> &[AuditEvent] {
        &self.events
    }

    pub fn consent_receipts(&self) -> &[ConsentReceipt] {
        &self.consent_receipts
    }

    pub fn clear(&mut self) {
        self.events.clear();
        self.consent_receipts.clear();
    }

    pub fn export_incident_bundle(&self, retention_days: u16) -> AuditExport {
        let now = Utc::now();
        let (events, root_hash) = retained_event_chain(&self.events, retention_days, now);
        let consent_receipts =
            retained_consent_receipts(&self.consent_receipts, retention_days, now);
        AuditExport {
            export_version: AUDIT_EXPORT_VERSION.to_string(),
            exported_at: now,
            raw_bodies_included: false,
            retention_days,
            events,
            consent_receipts,
            root_hash,
        }
    }

    pub fn from_verified_export(
        scanner: SecretScanner,
        export: AuditExport,
    ) -> Result<Self, AuditStoreError> {
        if !export.verify_hash_chain() {
            return Err(AuditStoreError::HashChainInvalid);
        }
        Ok(Self {
            events: export.events,
            consent_receipts: export.consent_receipts,
            scanner,
        })
    }
}

impl AuditExport {
    pub fn verify_hash_chain(&self) -> bool {
        let mut expected_previous = ZERO_HASH.to_string();
        for event in &self.events {
            if event.previous_hash != expected_previous {
                return false;
            }
            let expected_hash = hash_event(
                &event.at,
                &event.class,
                event.request_id.as_deref(),
                &event.summary,
                event.user_visible,
                &event.previous_hash,
            );
            if event.event_hash != expected_hash {
                return false;
            }
            expected_previous = event.event_hash.clone();
        }
        self.root_hash == expected_previous && !self.raw_bodies_included
    }
}

#[derive(Debug, Clone)]
pub struct LocalAuditStore {
    path: PathBuf,
    retention_days: u16,
    scanner: SecretScanner,
}

impl LocalAuditStore {
    pub fn new(path: impl Into<PathBuf>, retention_days: u16, scanner: SecretScanner) -> Self {
        Self {
            path: path.into(),
            retention_days,
            scanner,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn retention_days(&self) -> u16 {
        self.retention_days
    }

    pub fn load(&self) -> Result<AuditLog, AuditStoreError> {
        ensure_audit_path_safe(&self.path)?;
        if !self.path.exists() {
            return Ok(AuditLog::new(self.scanner.clone()));
        }
        let metadata = fs::metadata(&self.path).map_err(AuditStoreError::Io)?;
        if metadata.len() > MAX_AUDIT_STORE_BYTES {
            return Err(AuditStoreError::TooLarge);
        }
        let bytes = fs::read(&self.path).map_err(AuditStoreError::Io)?;
        let export: AuditExport = serde_json::from_slice(&bytes).map_err(AuditStoreError::Json)?;
        AuditLog::from_verified_export(self.scanner.clone(), export)
    }

    pub fn persist(&self, log: &AuditLog) -> Result<(), AuditStoreError> {
        ensure_audit_path_safe(&self.path)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(AuditStoreError::Io)?;
        }
        let export = log.export_incident_bundle(self.retention_days);
        let bytes = serde_json::to_vec_pretty(&export).map_err(AuditStoreError::Json)?;
        if bytes.len() as u64 > MAX_AUDIT_STORE_BYTES {
            return Err(AuditStoreError::TooLarge);
        }
        let tmp = self.path.with_extension("json.tmp");
        ensure_audit_path_safe(&self.path)?;
        ensure_audit_path_safe(&tmp)?;
        fs::write(&tmp, bytes).map_err(AuditStoreError::Io)?;
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AuditStoreError::Io(error)),
        }
        fs::rename(&tmp, &self.path).map_err(AuditStoreError::Io)?;
        Ok(())
    }

    pub fn delete(&self) -> Result<(), AuditStoreError> {
        ensure_audit_path_safe(&self.path)?;
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AuditStoreError::Io(error)),
        }
    }
}

#[derive(Debug)]
pub enum AuditStoreError {
    Io(std::io::Error),
    Json(serde_json::Error),
    HashChainInvalid,
    TooLarge,
    UnsafePath,
}

impl std::fmt::Display for AuditStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "audit store io error: {error}"),
            Self::Json(error) => write!(formatter, "audit store json error: {error}"),
            Self::HashChainInvalid => write!(formatter, "audit store hash chain invalid"),
            Self::TooLarge => write!(formatter, "audit store file too large"),
            Self::UnsafePath => write!(formatter, "audit store unsafe path"),
        }
    }
}

impl std::error::Error for AuditStoreError {}

fn ensure_audit_path_safe(path: &Path) -> Result<(), AuditStoreError> {
    for component in path.ancestors() {
        if !component.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(component).map_err(AuditStoreError::Io)?;
        if metadata.file_type().is_symlink() {
            return Err(AuditStoreError::UnsafePath);
        }
    }
    Ok(())
}

fn retained_event_chain(
    events: &[AuditEvent],
    retention_days: u16,
    now: DateTime<Utc>,
) -> (Vec<AuditEvent>, String) {
    if retention_days == 0 {
        return (Vec::new(), ZERO_HASH.to_string());
    }
    let cutoff = now - Duration::days(i64::from(retention_days));
    let mut previous_hash = ZERO_HASH.to_string();
    let mut retained = Vec::new();
    for event in events.iter().filter(|event| event.at >= cutoff) {
        let mut event = event.clone();
        event.previous_hash = previous_hash;
        event.event_hash = hash_event(
            &event.at,
            &event.class,
            event.request_id.as_deref(),
            &event.summary,
            event.user_visible,
            &event.previous_hash,
        );
        previous_hash = event.event_hash.clone();
        retained.push(event);
    }
    (retained, previous_hash)
}

fn retained_consent_receipts(
    receipts: &[ConsentReceipt],
    retention_days: u16,
    now: DateTime<Utc>,
) -> Vec<ConsentReceipt> {
    if retention_days == 0 {
        return Vec::new();
    }
    let cutoff = now - Duration::days(i64::from(retention_days));
    receipts
        .iter()
        .filter(|receipt| receipt.granted_at >= cutoff)
        .cloned()
        .collect()
}

fn hash_event(
    at: &DateTime<Utc>,
    class: &AuditClass,
    request_id: Option<&str>,
    summary: &str,
    user_visible: bool,
    previous_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(AUDIT_EXPORT_VERSION.as_bytes());
    hasher.update(b"\0");
    hasher.update(previous_hash.as_bytes());
    hasher.update(b"\0");
    hasher.update(at.to_rfc3339().as_bytes());
    hasher.update(b"\0");
    hasher.update(format!("{class:?}").as_bytes());
    hasher.update(b"\0");
    hasher.update(request_id.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(summary.as_bytes());
    hasher.update(b"\0");
    hasher.update(if user_visible { b"1" } else { b"0" });
    format!("sha256:{}", hex::encode(hasher.finalize()))
}
