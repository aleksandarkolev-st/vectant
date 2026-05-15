// ============================================================
// UNIFIED DIAGNOSTICS SCHEMA
// ============================================================
// One schema for compile diagnostics across all compiled languages.
// Frontend overlay, healing service, and AI backend all consume
// the same shape — no more event-name or field-name drift.
// ============================================================

use serde::{Deserialize, Serialize};

/// Severity of a single diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Note,
    Help,
    Info,
}

/// Source location attached to a diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticLocation {
    /// Relative file path (e.g. "gui.cpp").
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column number.
    pub column: u32,
    /// Optional end line for range spans.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Optional end column for range spans.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

/// A single compiler diagnostic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<DiagnosticLocation>,
    /// Optional source snippet around the error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Compiler-suggested fix, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// A diagnostics payload emitted after a compile attempt.
///
/// Both the frontend ErrorOverlay and the AI healing service
/// should consume this exact shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileDiagnosticsPayload {
    /// Unique preview session id.
    pub preview_id: String,
    /// Language that was compiled (e.g. "cpp", "java", "rust").
    pub language: String,
    /// Which module produced the diagnostics (e.g. "core", "gui", "widget:hud").
    pub module: String,
    /// All diagnostics from this compile pass.
    pub diagnostics: Vec<Diagnostic>,
    /// Count of error-severity diagnostics.
    pub error_count: u32,
    /// Count of warning-severity diagnostics.
    pub warning_count: u32,
    /// Wall-clock compile duration in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_duration_ms: Option<u64>,
    /// Epoch millis timestamp.
    pub timestamp_ms: u64,
}

impl CompileDiagnosticsPayload {
    /// Convenience: create a payload from a list of diagnostics.
    pub fn from_diagnostics(
        preview_id: impl Into<String>,
        language: impl Into<String>,
        module: impl Into<String>,
        diagnostics: Vec<Diagnostic>,
    ) -> Self {
        let error_count = diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Error)
            .count() as u32;
        let warning_count = diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Warning)
            .count() as u32;

        Self {
            preview_id: preview_id.into(),
            language: language.into(),
            module: module.into(),
            diagnostics,
            error_count,
            warning_count,
            compile_duration_ms: None,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }

    /// Returns true when this payload contains at least one error.
    pub fn has_errors(&self) -> bool {
        self.error_count > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_payload_counts() {
        let diags = vec![
            Diagnostic {
                severity: DiagnosticSeverity::Error,
                message: "undeclared identifier 'foo'".into(),
                code: Some("E0001".into()),
                location: Some(DiagnosticLocation {
                    file: "gui.cpp".into(),
                    line: 42,
                    column: 5,
                    end_line: None,
                    end_column: None,
                }),
                snippet: None,
                suggestion: None,
            },
            Diagnostic {
                severity: DiagnosticSeverity::Warning,
                message: "unused variable 'x'".into(),
                code: None,
                location: None,
                snippet: None,
                suggestion: None,
            },
        ];
        let payload = CompileDiagnosticsPayload::from_diagnostics("p1", "cpp", "gui", diags);
        assert_eq!(payload.error_count, 1);
        assert_eq!(payload.warning_count, 1);
        assert!(payload.has_errors());
    }

    #[test]
    fn diagnostics_serde_roundtrip() {
        let payload = CompileDiagnosticsPayload::from_diagnostics("p2", "rust", "core", vec![]);
        let json = serde_json::to_string(&payload).unwrap();
        let de: CompileDiagnosticsPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(de.preview_id, "p2");
        assert!(!de.has_errors());
    }
}
