use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::scanner::SecretScanner;

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
}

#[derive(Debug, Clone, Default)]
pub struct AuditLog {
    events: Vec<AuditEvent>,
    scanner: SecretScanner,
}

impl AuditLog {
    pub fn new(scanner: SecretScanner) -> Self {
        Self {
            events: Vec::new(),
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
        self.events.push(AuditEvent {
            at: Utc::now(),
            class,
            request_id,
            summary: scrubbed,
            user_visible,
        });
    }

    pub fn events(&self) -> &[AuditEvent] {
        &self.events
    }
}
