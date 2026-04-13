// ============================================================
// FLUTTER DIAGNOSTICS PARSER
// ============================================================
// Parses Flutter/Dart compiler errors and warnings from build output.
// Extracts file paths, line numbers, and error messages.
// ============================================================

use crate::android::routing::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::sync::LazyLock;

/// Regex patterns for Dart/Flutter error parsing
static DART_ERROR_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Matches: lib/main.dart:10:5: Error: Expected ';' after this.
    // Or: lib/main.dart:10:5: error: Expected ';' after this.
    Regex::new(
        r"^([^:]+):(\d+):(\d+):\s*(Error|error|Warning|warning|Info|info|Hint|hint):\s*(.+)$",
    )
    .expect("Invalid dart error regex")
});

static FLUTTER_ANALYSIS_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Matches: error • Message • lib/file.dart:10:5 • error_code
    // Or: warning • Message • lib/file.dart:10:5 • warning_code
    Regex::new(
        r"^\s*(error|warning|info|hint)\s*[•·]\s*(.+?)\s*[•·]\s*([^:]+):(\d+):(\d+)\s*[•·]\s*(\w+)",
    )
    .expect("Invalid flutter analysis regex")
});

static GRADLE_ERROR_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Matches: e: file:///path/to/File.kt:10:5 Error message
    Regex::new(r"^e:\s*(?:file://)?([^:]+):(\d+):(\d+)\s+(.+)$")
        .expect("Invalid gradle error regex")
});

static BUILD_FAILED_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Matches: FAILURE: Build failed with an exception.
    Regex::new(r"(?i)(FAILURE|BUILD FAILED|error:|Exception:)").expect("Invalid build failed regex")
});

/// Parses Flutter/Dart diagnostics from command output
pub fn parse_flutter_diagnostics(stdout: &str, stderr: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let combined = format!("{}\n{}", stdout, stderr);

    for line in combined.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try Dart compiler error format
        if let Some(diag) = parse_dart_error(trimmed) {
            diagnostics.push(diag);
            continue;
        }

        // Try Flutter analysis format
        if let Some(diag) = parse_flutter_analysis(trimmed) {
            diagnostics.push(diag);
            continue;
        }

        // Try Gradle/Kotlin error format (for native Android code in Flutter)
        if let Some(diag) = parse_gradle_error(trimmed) {
            diagnostics.push(diag);
            continue;
        }

        // Check for general build failures
        if let Some(diag) = parse_build_failure(trimmed) {
            diagnostics.push(diag);
        }
    }

    // Deduplicate diagnostics
    diagnostics.sort_by(|a, b| {
        (&a.file, a.line, a.column, &a.message).cmp(&(&b.file, b.line, b.column, &b.message))
    });
    diagnostics.dedup_by(|a, b| {
        a.file == b.file && a.line == b.line && a.column == b.column && a.message == b.message
    });

    diagnostics
}

/// Parses Dart compiler error format
/// Format: file.dart:10:5: Error: message
fn parse_dart_error(line: &str) -> Option<Diagnostic> {
    let caps = DART_ERROR_PATTERN.captures(line)?;

    let file = caps.get(1)?.as_str().to_string();
    let line_num = caps.get(2)?.as_str().parse::<u32>().ok()?;
    let column = caps.get(3)?.as_str().parse::<u32>().ok()?;
    let severity = caps.get(4)?.as_str().to_lowercase();
    let message = caps.get(5)?.as_str().to_string();

    let severity_enum = match severity.as_str() {
        "error" => DiagnosticSeverity::Error,
        "warning" => DiagnosticSeverity::Warning,
        "info" | "hint" => DiagnosticSeverity::Info,
        _ => DiagnosticSeverity::Error,
    };

    Some(Diagnostic {
        file,
        line: line_num,
        column,
        message,
        severity: severity_enum,
        code: None,
    })
}

/// Parses Flutter analysis format
/// Format: error • Message • lib/file.dart:10:5 • error_code
fn parse_flutter_analysis(line: &str) -> Option<Diagnostic> {
    let caps = FLUTTER_ANALYSIS_PATTERN.captures(line)?;

    let severity = caps.get(1)?.as_str().to_lowercase();
    let message = caps.get(2)?.as_str().trim().to_string();
    let file = caps.get(3)?.as_str().to_string();
    let line_num = caps.get(4)?.as_str().parse::<u32>().ok()?;
    let column = caps.get(5)?.as_str().parse::<u32>().ok()?;
    let code = caps.get(6).map(|m| m.as_str().to_string());

    let severity_enum = match severity.as_str() {
        "error" => DiagnosticSeverity::Error,
        "warning" => DiagnosticSeverity::Warning,
        "info" | "hint" => DiagnosticSeverity::Info,
        _ => DiagnosticSeverity::Error,
    };

    Some(Diagnostic {
        file,
        line: line_num,
        column,
        message,
        severity: severity_enum,
        code,
    })
}

/// Parses Gradle/Kotlin error format (for native code)
/// Format: e: file:///path/File.kt:10:5 Error message
fn parse_gradle_error(line: &str) -> Option<Diagnostic> {
    let caps = GRADLE_ERROR_PATTERN.captures(line)?;

    let file = caps.get(1)?.as_str().to_string();
    let line_num = caps.get(2)?.as_str().parse::<u32>().ok()?;
    let column = caps.get(3)?.as_str().parse::<u32>().ok()?;
    let message = caps.get(4)?.as_str().to_string();

    Some(Diagnostic {
        file,
        line: line_num,
        column,
        message,
        severity: DiagnosticSeverity::Error,
        code: None,
    })
}

/// Parses general build failures
fn parse_build_failure(line: &str) -> Option<Diagnostic> {
    if !BUILD_FAILED_PATTERN.is_match(line) {
        return None;
    }

    // Skip if it's just a pattern match without useful info
    if line.len() < 20 {
        return None;
    }

    // Don't create diagnostic for lines that were already parsed
    if line.contains(':')
        && (line.chars().filter(|c| *c == ':').count() >= 3
            || line.starts_with("e:")
            || line.contains("• "))
    {
        return None;
    }

    Some(Diagnostic {
        file: String::new(),
        line: 0,
        column: 0,
        message: line.to_string(),
        severity: DiagnosticSeverity::Error,
        code: None,
    })
}

/// Extracts the main error message from Flutter build output
pub fn extract_main_error(stdout: &str, stderr: &str) -> Option<String> {
    let combined = format!("{}\n{}", stderr, stdout);

    // Look for common Flutter error patterns
    let error_patterns = [
        "Error:",
        "Exception:",
        "FAILURE:",
        "BUILD FAILED",
        "Could not",
        "Unable to",
        "No connected devices",
        "No supported devices",
    ];

    for line in combined.lines() {
        let trimmed = line.trim();
        for pattern in &error_patterns {
            if trimmed.contains(pattern) {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dart_error() {
        let line = "lib/main.dart:10:5: Error: Expected ';' after this.";
        let diag = parse_dart_error(line).unwrap();
        assert_eq!(diag.file, "lib/main.dart");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.column, Some(5));
        assert_eq!(diag.severity, "error");
        assert!(diag.message.contains("Expected ';'"));
    }

    #[test]
    fn test_parse_flutter_analysis() {
        let line = "error • Undefined name 'foo' • lib/main.dart:15:10 • undefined_identifier";
        let diag = parse_flutter_analysis(line).unwrap();
        assert_eq!(diag.file, "lib/main.dart");
        assert_eq!(diag.line, 15);
        assert_eq!(diag.column, Some(10));
        assert_eq!(diag.severity, "error");
        assert_eq!(diag.code, Some("undefined_identifier".to_string()));
    }

    #[test]
    fn test_parse_gradle_error() {
        let line = "e: /project/android/app/src/main/kotlin/MainActivity.kt:10:5 Unresolved reference: foo";
        let diag = parse_gradle_error(line).unwrap();
        assert!(diag.file.contains("MainActivity.kt"));
        assert_eq!(diag.line, 10);
        assert_eq!(diag.severity, "error");
    }
}
