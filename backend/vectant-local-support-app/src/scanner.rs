use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::policy::Classification;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretFinding {
    pub kind: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanReport {
    pub classification: Classification,
    pub findings: Vec<SecretFinding>,
    pub scanner_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannerError {
    Unavailable,
}

#[derive(Debug, Clone)]
pub struct SecretScanner {
    patterns: Vec<(&'static str, Regex)>,
    version: String,
    unavailable: bool,
}

impl SecretScanner {
    pub fn new(version: impl Into<String>) -> Self {
        let specs = [
            ("github_token", r"gh[pousr]_[A-Za-z0-9_]{20,}"),
            ("openai_api_key", r"sk-[A-Za-z0-9_-]{20,}"),
            ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
            ("jwt", r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
            ("private_key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            (
                "database_url",
                r#"(?i)\b(postgres|postgresql|mysql|mongodb|redis)://[^\s'"<>]+"#,
            ),
            ("authorization_header", r"(?i)\bauthorization:\s*(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"),
            ("cookie", r"(?i)\b(cookie|set-cookie):\s*[^\n\r;=]+=[^\n\r;]+"),
            ("npm_token", r"npm_[A-Za-z0-9]{20,}"),
            ("firebase_service_account", r#""type"\s*:\s*"service_account""#),
        ];
        let patterns = specs
            .into_iter()
            .map(|(name, pattern)| (name, Regex::new(pattern).expect("valid scanner regex")))
            .collect();
        Self {
            patterns,
            version: version.into(),
            unavailable: false,
        }
    }

    pub fn unavailable(version: impl Into<String>) -> Self {
        Self {
            patterns: Vec::new(),
            version: version.into(),
            unavailable: true,
        }
    }

    pub fn try_scan(&self, input: &str) -> Result<ScanReport, ScannerError> {
        if self.unavailable {
            return Err(ScannerError::Unavailable);
        }
        Ok(self.scan(input))
    }

    pub fn scan(&self, input: &str) -> ScanReport {
        let mut findings = Vec::new();
        for (name, regex) in &self.patterns {
            for m in regex.find_iter(input) {
                findings.push(SecretFinding {
                    kind: (*name).to_string(),
                    start: m.start(),
                    end: m.end(),
                });
            }
        }
        findings.sort_by_key(|finding| finding.start);
        let classification = if findings.is_empty() {
            Classification::L2
        } else {
            Classification::L4
        };
        ScanReport {
            classification,
            findings,
            scanner_version: self.version.clone(),
        }
    }

    pub fn redact(&self, input: &str, report: &ScanReport) -> String {
        if report.findings.is_empty() {
            return input.to_string();
        }

        let mut out = String::with_capacity(input.len());
        let mut cursor = 0;
        for finding in &report.findings {
            if finding.start < cursor {
                continue;
            }
            out.push_str(&input[cursor..finding.start]);
            out.push_str("[REDACTED:");
            out.push_str(&finding.kind);
            out.push(']');
            cursor = finding.end;
        }
        out.push_str(&input[cursor..]);
        out
    }
}

impl Default for SecretScanner {
    fn default() -> Self {
        Self::new(crate::SCANNER_VERSION)
    }
}
