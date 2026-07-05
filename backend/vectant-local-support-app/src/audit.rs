use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::policy::Classification;
use crate::scanner::SecretScanner;

const AUDIT_EXPORT_VERSION: &str = "local-support-audit-v1";
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
        let report = self.scanner.scan(summary.as_ref());
        let scrubbed = self.scanner.redact(summary.as_ref(), &report);
        let at = Utc::now();
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
        self.append(
            AuditClass::Control,
            Some(receipt.request_id.clone()),
            format!(
                "Consent {} granted for {} by {} on {}.",
                receipt.approval_id, receipt.capability, receipt.actor, receipt.target_display
            ),
            true,
        );
        self.consent_receipts.push(receipt);
    }

    pub fn events(&self) -> &[AuditEvent] {
        &self.events
    }

    pub fn consent_receipts(&self) -> &[ConsentReceipt] {
        &self.consent_receipts
    }

    pub fn export_incident_bundle(&self, retention_days: u16) -> AuditExport {
        AuditExport {
            export_version: AUDIT_EXPORT_VERSION.to_string(),
            exported_at: Utc::now(),
            raw_bodies_included: false,
            retention_days,
            events: self.events.clone(),
            consent_receipts: self.consent_receipts.clone(),
            root_hash: self
                .events
                .last()
                .map(|event| event.event_hash.clone())
                .unwrap_or_else(|| ZERO_HASH.to_string()),
        }
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
