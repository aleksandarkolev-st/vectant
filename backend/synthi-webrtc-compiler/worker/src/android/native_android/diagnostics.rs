// ============================================================
// NATIVE ANDROID DIAGNOSTICS
// ============================================================
// Error and warning parsing for Java, Kotlin, and Gradle output.
// Converts compiler output into structured diagnostics.
// ============================================================

use crate::android::routing::Diagnostic;
use std::path::PathBuf;

// ============================================================
// DIAGNOSTIC PARSING
// ============================================================

/// Parses a Gradle output line for diagnostics
pub fn parse_gradle_diagnostic(line: &str) -> Option<Diagnostic> {
    let line = line.trim();
    
    // Skip non-diagnostic lines
    if line.is_empty() || line.starts_with('>') || line.starts_with("BUILD") {
        return None;
    }

    // Pattern: FAILURE: Build failed with an exception.
    if line.contains("FAILURE:") {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("GRADLE_FAILURE".to_string()),
        });
    }

    // Pattern: * What went wrong:
    if line.starts_with("* What went wrong:") {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("GRADLE_ERROR".to_string()),
        });
    }

    // Pattern: Execution failed for task ':app:compileDebugJavaWithJavac'.
    if line.contains("Execution failed for task") {
        let task = extract_task_name(line);
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some(format!("TASK_FAILED:{}", task.unwrap_or_default())),
        });
    }

    // Pattern: Could not resolve com.android.tools.build:gradle:8.2.0
    if line.contains("Could not resolve") || line.contains("Could not find") {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("DEPENDENCY_RESOLUTION".to_string()),
        });
    }

    // Pattern: w: warning message
    if line.starts_with("w:") {
        return Some(Diagnostic {
            severity: "warning".to_string(),
            message: line[2..].trim().to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("GRADLE_WARNING".to_string()),
        });
    }

    None
}

/// Parses a Java compiler output line for diagnostics
pub fn parse_java_diagnostic(line: &str) -> Option<Diagnostic> {
    let line = line.trim();

    // Pattern: /path/to/File.java:10: error: message
    // Pattern: /path/to/File.java:10:5: error: message
    if !line.contains(".java:") {
        return None;
    }

    let parts: Vec<&str> = line.splitn(4, ':').collect();
    if parts.len() < 3 {
        return None;
    }

    let file_path = parts[0].trim();
    if !file_path.ends_with(".java") {
        return None;
    }

    let line_num: Option<u32> = parts[1].trim().parse().ok();
    
    // Determine if column is present
    let (column, severity_idx) = if parts.len() >= 4 {
        if let Ok(col) = parts[2].trim().parse::<u32>() {
            (Some(col), 3)
        } else {
            (None, 2)
        }
    } else {
        (None, 2)
    };

    // Parse severity and message
    let rest = if severity_idx < parts.len() {
        parts[severity_idx..].join(":")
    } else {
        return None;
    };

    let (severity, message) = parse_severity_and_message(&rest);

    Some(Diagnostic {
        severity,
        message,
        file: Some(file_path.to_string()),
        line: line_num,
        column,
        code: Some("JAVAC".to_string()),
    })
}

/// Parses a Kotlin compiler output line for diagnostics
pub fn parse_kotlin_diagnostic(line: &str) -> Option<Diagnostic> {
    let line = line.trim();

    // Pattern: e: /path/to/File.kt: (10, 5): error message
    // Pattern: w: /path/to/File.kt: (10, 5): warning message
    // Pattern: e: file:///path/to/File.kt:10:5 error message

    let (severity, rest) = if line.starts_with("e:") {
        ("error".to_string(), line[2..].trim())
    } else if line.starts_with("w:") {
        ("warning".to_string(), line[2..].trim())
    } else if line.contains(".kt:") || line.contains(".kts:") {
        // Try to parse without prefix
        ("error".to_string(), line)
    } else {
        return None;
    };

    // Try pattern: /path/to/File.kt: (10, 5): message
    if let Some(parsed) = parse_kotlin_paren_format(rest, &severity) {
        return Some(parsed);
    }

    // Try pattern: /path/to/File.kt:10:5: message
    if let Some(parsed) = parse_kotlin_colon_format(rest, &severity) {
        return Some(parsed);
    }

    // Fallback: just capture as general Kotlin error
    if rest.contains(".kt") {
        return Some(Diagnostic {
            severity,
            message: rest.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("KOTLINC".to_string()),
        });
    }

    None
}

/// Parses Kotlin format: /path/File.kt: (10, 5): message
fn parse_kotlin_paren_format(line: &str, severity: &str) -> Option<Diagnostic> {
    // Find the pattern ": ("
    let paren_idx = line.find(": (")?;
    let file_path = line[..paren_idx].trim();
    
    // Remove file:// prefix if present
    let file_path = file_path.strip_prefix("file://").unwrap_or(file_path);
    
    let rest = &line[paren_idx + 3..];
    let close_paren = rest.find(')')?;
    let coords = &rest[..close_paren];
    
    let parts: Vec<&str> = coords.split(',').collect();
    let line_num: u32 = parts.get(0)?.trim().parse().ok()?;
    let column: Option<u32> = parts.get(1).and_then(|s| s.trim().parse().ok());

    let message_start = rest.find("):")
        .map(|i| i + 2)
        .unwrap_or(close_paren + 1);
    let message = rest[message_start..].trim().to_string();

    Some(Diagnostic {
        severity: severity.to_string(),
        message,
        file: Some(file_path.to_string()),
        line: Some(line_num),
        column,
        code: Some("KOTLINC".to_string()),
    })
}

/// Parses Kotlin format: /path/File.kt:10:5: message
fn parse_kotlin_colon_format(line: &str, severity: &str) -> Option<Diagnostic> {
    // Find .kt or .kts
    let ext_idx = line.find(".kt")
        .map(|i| i + if line[i..].starts_with(".kts") { 4 } else { 3 })?;
    
    let file_path = &line[..ext_idx];
    let rest = &line[ext_idx..];
    
    // Skip the first colon if present
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    
    let parts: Vec<&str> = rest.splitn(3, ':').collect();
    if parts.is_empty() {
        return None;
    }

    let line_num: Option<u32> = parts.get(0).and_then(|s| s.trim().parse().ok());
    let column: Option<u32> = parts.get(1).and_then(|s| s.trim().parse().ok());
    let message = parts.get(2).map(|s| s.trim().to_string())
        .or_else(|| parts.get(1).map(|s| s.trim().to_string()))
        .unwrap_or_default();

    Some(Diagnostic {
        severity: severity.to_string(),
        message,
        file: Some(file_path.to_string()),
        line: line_num,
        column,
        code: Some("KOTLINC".to_string()),
    })
}

/// Parses Android-specific errors
pub fn parse_android_diagnostic(line: &str) -> Option<Diagnostic> {
    let line = line.trim();

    // AAPT errors
    if line.contains("AAPT:") || line.contains("aapt2") {
        let severity = if line.contains("error") { "error" } else { "warning" };
        return Some(Diagnostic {
            severity: severity.to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("AAPT".to_string()),
        });
    }

    // Resource errors
    if line.contains("resource") && (line.contains("not found") || line.contains("duplicate")) {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("RESOURCE".to_string()),
        });
    }

    // Manifest merge errors
    if line.contains("Manifest merger") {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: Some("AndroidManifest.xml".to_string()),
            line: None,
            column: None,
            code: Some("MANIFEST_MERGE".to_string()),
        });
    }

    // D8/R8 errors
    if line.contains("D8:") || line.contains("R8:") {
        return Some(Diagnostic {
            severity: "error".to_string(),
            message: line.to_string(),
            file: None,
            line: None,
            column: None,
            code: Some("DEX".to_string()),
        });
    }

    None
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

fn extract_task_name(line: &str) -> Option<String> {
    let start = line.find('\'')?;
    let rest = &line[start + 1..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

fn parse_severity_and_message(text: &str) -> (String, String) {
    let text = text.trim();
    
    if text.starts_with("error:") {
        ("error".to_string(), text[6..].trim().to_string())
    } else if text.starts_with("warning:") {
        ("warning".to_string(), text[8..].trim().to_string())
    } else if text.starts_with("note:") {
        ("info".to_string(), text[5..].trim().to_string())
    } else {
        ("error".to_string(), text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_java_diagnostic() {
        let line = "/home/user/project/app/src/main/java/com/example/MainActivity.java:25: error: cannot find symbol";
        let diag = parse_java_diagnostic(line).unwrap();
        
        assert_eq!(diag.severity, "error");
        assert!(diag.file.unwrap().contains("MainActivity.java"));
        assert_eq!(diag.line, Some(25));
    }

    #[test]
    fn test_parse_kotlin_diagnostic() {
        let line = "e: /home/user/project/app/src/main/kotlin/com/example/Main.kt: (15, 10): Unresolved reference: foo";
        let diag = parse_kotlin_diagnostic(line).unwrap();
        
        assert_eq!(diag.severity, "error");
        assert!(diag.file.unwrap().contains("Main.kt"));
        assert_eq!(diag.line, Some(15));
        assert_eq!(diag.column, Some(10));
    }

    #[test]
    fn test_parse_gradle_diagnostic() {
        let line = "FAILURE: Build failed with an exception.";
        let diag = parse_gradle_diagnostic(line).unwrap();
        
        assert_eq!(diag.severity, "error");
        assert!(diag.message.contains("FAILURE"));
    }

    #[test]
    fn test_parse_android_diagnostic() {
        let line = "AAPT: error: resource not found";
        let diag = parse_android_diagnostic(line).unwrap();
        
        assert_eq!(diag.severity, "error");
        assert_eq!(diag.code, Some("AAPT".to_string()));
    }
}
