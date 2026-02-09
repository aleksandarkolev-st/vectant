use crate::android::routing::{Diagnostic, DiagnosticSeverity};

/// Parses a line for Gradle build errors
pub(crate) fn parse_gradle_diagnostic(line: &str) -> Option<Diagnostic> {
    // Match Gradle error patterns:
    // > Task :app:compileDebugJavaWithJavac FAILED
    // /path/to/File.java:10: error: ';' expected
    // e: /path/to/File.kt:10:5 Expecting ')'

    let trimmed = line.trim();

    // Java compiler errors
    if let Some(caps) = regex::Regex::new(r"^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        let severity = match caps.get(3)?.as_str() {
            "error" => DiagnosticSeverity::Error,
            "warning" => DiagnosticSeverity::Warning,
            _ => return None,
        };
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: 1,
            severity,
            message: caps.get(4)?.as_str().to_string(),
            code: None,
        });
    }

    // Kotlin compiler errors (e: prefix)
    if let Some(caps) = regex::Regex::new(r"^e:\s*(.+\.kt):(\d+):(\d+)\s+(.+)$")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: caps.get(3)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(4)?.as_str().to_string(),
            code: None,
        });
    }

    None
}

/// Parses Metro bundler / JavaScript errors
pub(crate) fn parse_metro_diagnostic(line: &str) -> Option<Diagnostic> {
    // Match Metro/Babel/TypeScript errors:
    // ERROR  src/App.tsx:10:5 - error TS2322: Type 'string' is not assignable
    // SyntaxError: /path/to/file.js: Unexpected token (10:5)

    let trimmed = line.trim();

    // TypeScript errors from Metro
    if let Some(caps) =
        regex::Regex::new(r"^ERROR\s+(.+\.[jt]sx?):(\d+):(\d+)\s*-\s*error\s+(\w+):\s*(.+)$")
            .ok()
            .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(2)?.as_str().parse().ok()?,
            column: caps.get(3)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(5)?.as_str().to_string(),
            code: Some(caps.get(4)?.as_str().to_string()),
        });
    }

    // Babel syntax errors
    if let Some(caps) = regex::Regex::new(r"SyntaxError:\s*(.+\.[jt]sx?):\s*(.+)\s*\((\d+):(\d+)\)")
        .ok()
        .and_then(|re| re.captures(trimmed))
    {
        return Some(Diagnostic {
            file: caps.get(1)?.as_str().to_string(),
            line: caps.get(3)?.as_str().parse().ok()?,
            column: caps.get(4)?.as_str().parse().ok()?,
            severity: DiagnosticSeverity::Error,
            message: caps.get(2)?.as_str().to_string(),
            code: None,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gradle_java_error() {
        let line = "/src/main/java/com/app/MainActivity.java:25: error: ';' expected";
        let diag = parse_gradle_diagnostic(line).unwrap();

        assert_eq!(diag.file, "/src/main/java/com/app/MainActivity.java");
        assert_eq!(diag.line, 25);
        assert_eq!(diag.severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn test_parse_gradle_kotlin_error() {
        let line = "e: /src/main/kotlin/App.kt:10:5 Expecting ')'";
        let diag = parse_gradle_diagnostic(line).unwrap();

        assert_eq!(diag.file, "/src/main/kotlin/App.kt");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.column, 5);
        assert_eq!(diag.severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn test_parse_metro_typescript_error() {
        let line = "ERROR  src/App.tsx:10:5 - error TS2322: Type 'string' is not assignable";
        let diag = parse_metro_diagnostic(line).unwrap();

        assert_eq!(diag.file, "src/App.tsx");
        assert_eq!(diag.line, 10);
        assert_eq!(diag.code, Some("TS2322".to_string()));
    }

    #[test]
    fn test_parse_non_diagnostic() {
        let line = "> Task :app:compileDebugJavaWithJavac";
        assert!(parse_gradle_diagnostic(line).is_none());
    }
}
