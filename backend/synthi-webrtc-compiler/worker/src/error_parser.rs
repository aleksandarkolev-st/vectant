// ============================================================
// STRUCTURED ERROR PARSER MODULE
// ============================================================
// Parses compiler error output (g++, clang, rustc) into a
// structured format for display in the frontend.
//
// KEY FEATURES:
// - JSON output parsing from GCC/Clang (-fdiagnostics-format=json)
// - JSON output parsing from Rust (--error-format=json)
// - Fallback regex-based parsing for raw text errors
// - Severity classification (error, warning, note, help)
// - Spans and suggestions extraction
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================
// STRUCTURED ERROR TYPES
// ============================================================

/// Severity level for compiler diagnostics
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Note,
    Help,
    Info,
}

impl DiagnosticSeverity {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "error" | "fatal error" => DiagnosticSeverity::Error,
            "warning" => DiagnosticSeverity::Warning,
            "note" => DiagnosticSeverity::Note,
            "help" => DiagnosticSeverity::Help,
            _ => DiagnosticSeverity::Info,
        }
    }
    
    pub fn as_str(&self) -> &'static str {
        match self {
            DiagnosticSeverity::Error => "error",
            DiagnosticSeverity::Warning => "warning",
            DiagnosticSeverity::Note => "note",
            DiagnosticSeverity::Help => "help",
            DiagnosticSeverity::Info => "info",
        }
    }
}

/// Source location for a diagnostic
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLocation {
    /// File path (relative or absolute)
    pub file: String,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (1-indexed)
    pub column: u32,
    /// End line (for spans)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// End column (for spans)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

impl SourceLocation {
    pub fn new(file: String, line: u32, column: u32) -> Self {
        Self {
            file,
            line,
            column,
            end_line: None,
            end_column: None,
        }
    }
    
    pub fn with_span(file: String, line: u32, column: u32, end_line: u32, end_column: u32) -> Self {
        Self {
            file,
            line,
            column,
            end_line: Some(end_line),
            end_column: Some(end_column),
        }
    }
}

/// Code suggestion/fix for a diagnostic
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeSuggestion {
    /// Description of the fix
    pub message: String,
    /// Suggested replacement text
    pub replacement: String,
    /// Location where the replacement should be applied
    pub location: SourceLocation,
}

/// A single compiler diagnostic
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Severity (error, warning, note, etc.)
    pub severity: DiagnosticSeverity,
    /// Error code (e.g., "E0001" for Rust, error number for GCC)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Main error message
    pub message: String,
    /// Primary source location
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
    /// Related notes/helps (child diagnostics)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Diagnostic>,
    /// Suggested fixes
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<CodeSuggestion>,
    /// Raw text that generated this diagnostic (for debugging)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    /// Code snippet around the error location (for display in error overlay)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "codeSnippet")]
    pub code_snippet: Option<String>,
    /// First line number of the code snippet
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "snippetStartLine")]
    pub snippet_start_line: Option<u32>,
}

impl Diagnostic {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            code: None,
            message: message.into(),
            location: None,
            related: Vec::new(),
            suggestions: Vec::new(),
            raw_text: None,
            code_snippet: None,
            snippet_start_line: None,
        }
    }
    
    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Warning,
            code: None,
            message: message.into(),
            location: None,
            related: Vec::new(),
            suggestions: Vec::new(),
            raw_text: None,
            code_snippet: None,
            snippet_start_line: None,
        }
    }
    
    pub fn with_location(mut self, loc: SourceLocation) -> Self {
        self.location = Some(loc);
        self
    }
    
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
    
    /// Add a code snippet from a source file
    pub fn with_code_snippet(mut self, snippet: String, start_line: u32) -> Self {
        self.code_snippet = Some(snippet);
        self.snippet_start_line = Some(start_line);
        self
    }
    
    /// Convert to JSON string
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Collection of diagnostics from a compilation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticReport {
    /// Module name (core, gui, main)
    pub module: String,
    /// All diagnostics
    pub diagnostics: Vec<Diagnostic>,
    /// Summary counts
    pub error_count: usize,
    pub warning_count: usize,
    /// Whether compilation succeeded
    pub success: bool,
}

impl DiagnosticReport {
    pub fn new(module: impl Into<String>) -> Self {
        Self {
            module: module.into(),
            diagnostics: Vec::new(),
            error_count: 0,
            warning_count: 0,
            success: true,
        }
    }
    
    pub fn add(&mut self, diag: Diagnostic) {
        match diag.severity {
            DiagnosticSeverity::Error => {
                self.error_count += 1;
                self.success = false;
            }
            DiagnosticSeverity::Warning => {
                self.warning_count += 1;
            }
            _ => {}
        }
        self.diagnostics.push(diag);
    }
    
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

// ============================================================
// GCC/CLANG JSON PARSER (-fdiagnostics-format=json)
// ============================================================

/// GCC JSON diagnostic format (GCC 10+)
#[derive(Debug, Deserialize)]
struct GccJsonDiagnostic {
    kind: String,
    message: String,
    #[serde(default)]
    option: Option<String>,
    #[serde(default)]
    locations: Vec<GccJsonLocation>,
    #[serde(default)]
    children: Vec<GccJsonDiagnostic>,
    #[serde(default)]
    fixits: Vec<GccJsonFixit>,
}

#[derive(Debug, Deserialize)]
struct GccJsonLocation {
    #[serde(default)]
    caret: Option<GccJsonPosition>,
    #[serde(default)]
    start: Option<GccJsonPosition>,
    #[serde(default)]
    finish: Option<GccJsonPosition>,
}

#[derive(Debug, Deserialize)]
struct GccJsonPosition {
    file: String,
    line: u32,
    column: u32,
}

#[derive(Debug, Deserialize)]
struct GccJsonFixit {
    start: GccJsonPosition,
    next: GccJsonPosition,
    string: String,
}

/// Parse GCC/Clang JSON diagnostic output
pub fn parse_gcc_json(json_str: &str, module: &str) -> DiagnosticReport {
    let mut report = DiagnosticReport::new(module);
    
    // GCC outputs multiple JSON objects, one per diagnostic
    // They may be separated by newlines or in an array
    let json_str = json_str.trim();
    
    // Try parsing as array first
    if json_str.starts_with('[') {
        if let Ok(diagnostics) = serde_json::from_str::<Vec<GccJsonDiagnostic>>(json_str) {
            for diag in diagnostics {
                report.add(convert_gcc_diagnostic(diag));
            }
            return report;
        }
    }
    
    // Try parsing line by line (GCC outputs one JSON per line)
    for line in json_str.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        
        if let Ok(diag) = serde_json::from_str::<GccJsonDiagnostic>(line) {
            report.add(convert_gcc_diagnostic(diag));
        }
    }
    
    report
}

fn convert_gcc_diagnostic(gcc: GccJsonDiagnostic) -> Diagnostic {
    let severity = DiagnosticSeverity::from_str(&gcc.kind);
    
    // Get primary location from caret or start
    let location = gcc.locations.first().and_then(|loc| {
        let pos = loc.caret.as_ref().or(loc.start.as_ref())?;
        let end = loc.finish.as_ref();
        
        if let Some(end) = end {
            Some(SourceLocation::with_span(
                pos.file.clone(),
                pos.line,
                pos.column,
                end.line,
                end.column,
            ))
        } else {
            Some(SourceLocation::new(pos.file.clone(), pos.line, pos.column))
        }
    });
    
    // Convert children (notes, etc.)
    let related: Vec<Diagnostic> = gcc.children
        .into_iter()
        .map(convert_gcc_diagnostic)
        .collect();
    
    // Convert fixits to suggestions
    let suggestions: Vec<CodeSuggestion> = gcc.fixits
        .into_iter()
        .map(|fixit| CodeSuggestion {
            message: "suggested fix".to_string(),
            replacement: fixit.string,
            location: SourceLocation::with_span(
                fixit.start.file,
                fixit.start.line,
                fixit.start.column,
                fixit.next.line,
                fixit.next.column,
            ),
        })
        .collect();
    
    Diagnostic {
        severity,
        code: gcc.option,
        message: gcc.message,
        location,
        related,
        suggestions,
        raw_text: None,
        code_snippet: None,
        snippet_start_line: None,
    }
}

// ============================================================
// RUSTC JSON PARSER (--error-format=json)
// ============================================================

/// Rustc JSON diagnostic format
#[derive(Debug, Deserialize)]
struct RustcJsonDiagnostic {
    message: String,
    code: Option<RustcCode>,
    level: String,
    #[serde(default)]
    spans: Vec<RustcSpan>,
    #[serde(default)]
    children: Vec<RustcJsonDiagnostic>,
    #[serde(default)]
    rendered: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RustcCode {
    code: String,
    #[serde(default)]
    explanation: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RustcSpan {
    file_name: String,
    line_start: u32,
    line_end: u32,
    column_start: u32,
    column_end: u32,
    is_primary: bool,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    suggested_replacement: Option<String>,
    #[serde(default)]
    suggestion_applicability: Option<String>,
}

/// Parse rustc JSON diagnostic output
pub fn parse_rustc_json(json_str: &str, module: &str) -> DiagnosticReport {
    let mut report = DiagnosticReport::new(module);
    
    for line in json_str.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        
        // Rustc wraps diagnostics in a {"$message_type": "diagnostic", ...} envelope
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            // Check if it's a diagnostic message
            if value.get("$message_type").and_then(|v| v.as_str()) == Some("diagnostic") 
               || value.get("message").is_some() 
            {
                if let Ok(diag) = serde_json::from_value::<RustcJsonDiagnostic>(value) {
                    report.add(convert_rustc_diagnostic(diag));
                }
            }
        }
    }
    
    report
}

fn convert_rustc_diagnostic(rustc: RustcJsonDiagnostic) -> Diagnostic {
    let severity = DiagnosticSeverity::from_str(&rustc.level);
    
    // Find primary span
    let primary_span = rustc.spans.iter().find(|s| s.is_primary);
    let location = primary_span.map(|span| {
        SourceLocation::with_span(
            span.file_name.clone(),
            span.line_start,
            span.column_start,
            span.line_end,
            span.column_end,
        )
    });
    
    // Convert children
    let related: Vec<Diagnostic> = rustc.children
        .into_iter()
        .map(convert_rustc_diagnostic)
        .collect();
    
    // Convert suggestions from spans
    let suggestions: Vec<CodeSuggestion> = rustc.spans
        .iter()
        .filter_map(|span| {
            let replacement = span.suggested_replacement.as_ref()?;
            Some(CodeSuggestion {
                message: span.label.clone().unwrap_or_else(|| "suggested replacement".to_string()),
                replacement: replacement.clone(),
                location: SourceLocation::with_span(
                    span.file_name.clone(),
                    span.line_start,
                    span.column_start,
                    span.line_end,
                    span.column_end,
                ),
            })
        })
        .collect();
    
    Diagnostic {
        severity,
        code: rustc.code.map(|c| c.code),
        message: rustc.message,
        location,
        related,
        suggestions,
        raw_text: rustc.rendered,
        code_snippet: None,
        snippet_start_line: None,
    }
}

// ============================================================
// FALLBACK REGEX-BASED PARSER
// ============================================================
// For when JSON output is not available or parsing fails

use regex::Regex;
use lazy_static::lazy_static;

lazy_static! {
    // GCC/Clang format: file:line:col: severity: message
    static ref GCC_ERROR_RE: Regex = Regex::new(
        r"(?m)^([^:\s][^:]*):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)$"
    ).unwrap();
    
    // GCC/Clang format without column: file:line: severity: message  
    static ref GCC_ERROR_NOCOL_RE: Regex = Regex::new(
        r"(?m)^([^:\s][^:]*):(\d+):\s*(error|warning|note|fatal error):\s*(.+)$"
    ).unwrap();
    
    // Rustc plain format: error[E0001]: message
    static ref RUSTC_ERROR_RE: Regex = Regex::new(
        r"(?m)^(error|warning|note|help)(?:\[([^\]]+)\])?:\s*(.+)$"
    ).unwrap();
    
    // Rustc location: --> file:line:col
    static ref RUSTC_LOCATION_RE: Regex = Regex::new(
        r"-->\s*([^:]+):(\d+):(\d+)"
    ).unwrap();
    
    // MSVC format: file(line,col): severity Cxxxx: message
    static ref MSVC_ERROR_RE: Regex = Regex::new(
        r"(?m)^([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]\d+):\s*(.+)$"
    ).unwrap();
}

/// Parse compiler output using regex patterns (fallback)
pub fn parse_text_errors(stderr: &str, module: &str) -> DiagnosticReport {
    let mut report = DiagnosticReport::new(module);
    
    // Try GCC/Clang format first (with column)
    for cap in GCC_ERROR_RE.captures_iter(stderr) {
        let file = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let line: u32 = cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        let col: u32 = cap.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        let severity = cap.get(4).map(|m| m.as_str()).unwrap_or("error");
        let message = cap.get(5).map(|m| m.as_str()).unwrap_or("");
        
        let diag = Diagnostic {
            severity: DiagnosticSeverity::from_str(severity),
            code: None,
            message: message.to_string(),
            location: Some(SourceLocation::new(file.to_string(), line, col)),
            related: Vec::new(),
            suggestions: Vec::new(),
            raw_text: Some(cap.get(0).map(|m| m.as_str()).unwrap_or("").to_string()),
            code_snippet: None,
            snippet_start_line: None,
        };
        
        report.add(diag);
    }
    
    // Try GCC/Clang format without column
    if report.diagnostics.is_empty() {
        for cap in GCC_ERROR_NOCOL_RE.captures_iter(stderr) {
            let file = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let line: u32 = cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let severity = cap.get(3).map(|m| m.as_str()).unwrap_or("error");
            let message = cap.get(4).map(|m| m.as_str()).unwrap_or("");
            
            let diag = Diagnostic {
                severity: DiagnosticSeverity::from_str(severity),
                code: None,
                message: message.to_string(),
                location: Some(SourceLocation::new(file.to_string(), line, 1)),
                related: Vec::new(),
                suggestions: Vec::new(),
                raw_text: Some(cap.get(0).map(|m| m.as_str()).unwrap_or("").to_string()),
                code_snippet: None,
                snippet_start_line: None,
            };
            
            report.add(diag);
        }
    }
    
    // Try MSVC format
    if report.diagnostics.is_empty() {
        for cap in MSVC_ERROR_RE.captures_iter(stderr) {
            let file = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let line: u32 = cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let col: u32 = cap.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let severity = cap.get(4).map(|m| m.as_str()).unwrap_or("error");
            let code = cap.get(5).map(|m| m.as_str().to_string());
            let message = cap.get(6).map(|m| m.as_str()).unwrap_or("");
            
            let diag = Diagnostic {
                severity: DiagnosticSeverity::from_str(severity),
                code,
                message: message.to_string(),
                location: Some(SourceLocation::new(file.to_string(), line, col)),
                related: Vec::new(),
                suggestions: Vec::new(),
                raw_text: Some(cap.get(0).map(|m| m.as_str()).unwrap_or("").to_string()),
                code_snippet: None,
                snippet_start_line: None,
            };
            
            report.add(diag);
        }
    }
    
    // Try Rustc plain format (more complex, needs to associate locations)
    if report.diagnostics.is_empty() {
        parse_rustc_text(stderr, &mut report);
    }
    
    // If nothing matched, create a single error with the raw text
    if report.diagnostics.is_empty() && !stderr.trim().is_empty() {
        // Check if it looks like an error
        let stderr_lower = stderr.to_lowercase();
        if stderr_lower.contains("error") || stderr_lower.contains("fail") {
            report.add(Diagnostic {
                severity: DiagnosticSeverity::Error,
                code: None,
                message: "Compilation failed".to_string(),
                location: None,
                related: Vec::new(),
                suggestions: Vec::new(),
                raw_text: Some(stderr.to_string()),
                code_snippet: None,
                snippet_start_line: None,
            });
        }
    }
    
    report
}

/// Parse Rustc plain text output
fn parse_rustc_text(stderr: &str, report: &mut DiagnosticReport) {
    let lines: Vec<&str> = stderr.lines().collect();
    let mut i = 0;
    
    while i < lines.len() {
        if let Some(cap) = RUSTC_ERROR_RE.captures(lines[i]) {
            let severity = cap.get(1).map(|m| m.as_str()).unwrap_or("error");
            let code = cap.get(2).map(|m| m.as_str().to_string());
            let message = cap.get(3).map(|m| m.as_str()).unwrap_or("");
            
            // Look for location in next few lines
            let mut location = None;
            for j in (i + 1)..std::cmp::min(i + 5, lines.len()) {
                if let Some(loc_cap) = RUSTC_LOCATION_RE.captures(lines[j]) {
                    let file = loc_cap.get(1).map(|m| m.as_str()).unwrap_or("");
                    let line: u32 = loc_cap.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
                    let col: u32 = loc_cap.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
                    location = Some(SourceLocation::new(file.to_string(), line, col));
                    break;
                }
            }
            
            let diag = Diagnostic {
                severity: DiagnosticSeverity::from_str(severity),
                code,
                message: message.to_string(),
                location,
                related: Vec::new(),
                suggestions: Vec::new(),
                raw_text: Some(lines[i].to_string()),
                code_snippet: None,
                snippet_start_line: None,
            };
            
            report.add(diag);
        }
        i += 1;
    }
}

// ============================================================
// UNIFIED PARSER
// ============================================================

/// Compiler type for selecting parser
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompilerType {
    Gcc,
    Clang,
    Rustc,
    Msvc,
    Unknown,
}

/// Parse compiler output, auto-detecting format
pub fn parse_compiler_output(
    stderr: &str,
    module: &str,
    compiler: CompilerType,
    is_json: bool,
) -> DiagnosticReport {
    if is_json {
        match compiler {
            CompilerType::Gcc | CompilerType::Clang => parse_gcc_json(stderr, module),
            CompilerType::Rustc => parse_rustc_json(stderr, module),
            _ => parse_text_errors(stderr, module),
        }
    } else {
        parse_text_errors(stderr, module)
    }
}

/// Get compiler flags for JSON output
pub fn get_json_diagnostic_flags(compiler: CompilerType) -> Vec<&'static str> {
    match compiler {
        CompilerType::Gcc | CompilerType::Clang => {
            vec!["-fdiagnostics-format=json"]
        }
        CompilerType::Rustc => {
            vec!["--error-format=json", "--json=diagnostic-rendered-ansi"]
        }
        CompilerType::Msvc => {
            // MSVC doesn't have JSON output, use /diagnostics:caret for better text
            vec!["/diagnostics:caret"]
        }
        CompilerType::Unknown => vec![],
    }
}

// ============================================================
// DIAGNOSTIC EVENT FOR WEBRTC DATA CHANNEL
// ============================================================

/// Structured diagnostic event for sending to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    /// Event type identifier
    #[serde(rename = "type")]
    pub event_type: String,
    /// Module that was compiled
    pub module: String,
    /// Session ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// All diagnostics (flattened from report for easy frontend access)
    pub diagnostics: Vec<Diagnostic>,
    /// Error count
    pub error_count: usize,
    /// Warning count
    pub warning_count: usize,
    /// Whether compilation succeeded
    pub success: bool,
}

impl DiagnosticEvent {
    pub fn new(module: impl Into<String>, report: DiagnosticReport) -> Self {
        Self {
            event_type: "compile-diagnostics".to_string(),
            module: module.into(),
            session_id: None,
            diagnostics: report.diagnostics,
            error_count: report.error_count,
            warning_count: report.warning_count,
            success: report.success,
        }
    }
    
    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
    
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

// ============================================================
// CODE SNIPPET EXTRACTION
// ============================================================

use std::path::Path;
use std::fs;

/// Extract a code snippet from a source file around a given line
/// Returns (snippet, start_line) where start_line is 1-indexed
pub fn extract_code_snippet(file_path: &str, line: u32, context_lines: u32) -> Option<(String, u32)> {
    let path = Path::new(file_path);
    let content = fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    
    if lines.is_empty() || line == 0 || line as usize > lines.len() {
        return None;
    }
    
    let line_idx = (line - 1) as usize;
    let start = line_idx.saturating_sub(context_lines as usize);
    let end = (line_idx + context_lines as usize + 1).min(lines.len());
    
    let snippet: Vec<&str> = lines[start..end].to_vec();
    Some((snippet.join("\n"), (start + 1) as u32))
}

/// Enrich diagnostics in a report with code snippets
/// `source_files` is a map of relative file names to their content
pub fn enrich_diagnostics_with_snippets(
    report: &mut DiagnosticReport,
    source_dir: &Path,
    source_files: &HashMap<String, String>,
) {
    for diag in &mut report.diagnostics {
        if let Some(ref loc) = diag.location {
            // Try to get snippet from in-memory files first
            if let Some(content) = source_files.get(&loc.file) {
                if let Some((snippet, start)) = extract_snippet_from_content(content, loc.line, 3) {
                    diag.code_snippet = Some(snippet);
                    diag.snippet_start_line = Some(start);
                    continue;
                }
            }
            
            // Fall back to file system
            let file_path = source_dir.join(&loc.file);
            if file_path.exists() {
                if let Some((snippet, start)) = extract_code_snippet(
                    file_path.to_str().unwrap_or(""),
                    loc.line,
                    3,
                ) {
                    diag.code_snippet = Some(snippet);
                    diag.snippet_start_line = Some(start);
                }
            }
        }
        
        // Also enrich related diagnostics
        for related in &mut diag.related {
            if let Some(ref loc) = related.location {
                if let Some(content) = source_files.get(&loc.file) {
                    if let Some((snippet, start)) = extract_snippet_from_content(content, loc.line, 2) {
                        related.code_snippet = Some(snippet);
                        related.snippet_start_line = Some(start);
                        continue;
                    }
                }
                
                let file_path = source_dir.join(&loc.file);
                if file_path.exists() {
                    if let Some((snippet, start)) = extract_code_snippet(
                        file_path.to_str().unwrap_or(""),
                        loc.line,
                        2,
                    ) {
                        related.code_snippet = Some(snippet);
                        related.snippet_start_line = Some(start);
                    }
                }
            }
        }
    }
}

/// Extract snippet from in-memory content
fn extract_snippet_from_content(content: &str, line: u32, context_lines: u32) -> Option<(String, u32)> {
    let lines: Vec<&str> = content.lines().collect();
    
    if lines.is_empty() || line == 0 || line as usize > lines.len() {
        return None;
    }
    
    let line_idx = (line - 1) as usize;
    let start = line_idx.saturating_sub(context_lines as usize);
    let end = (line_idx + context_lines as usize + 1).min(lines.len());
    
    let snippet: Vec<&str> = lines[start..end].to_vec();
    Some((snippet.join("\n"), (start + 1) as u32))
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_gcc_text_error() {
        let stderr = r#"core.cpp:42:15: error: 'undefined_var' was not declared in this scope
   42 |     int x = undefined_var;
      |             ^~~~~~~~~~~~~
core.cpp:50:1: warning: unused variable 'y' [-Wunused-variable]
   50 | int y = 5;
      | ^~~"#;
        
        let report = parse_text_errors(stderr, "core");
        assert_eq!(report.error_count, 1);
        assert_eq!(report.warning_count, 1);
        assert_eq!(report.diagnostics.len(), 2);
        
        let first = &report.diagnostics[0];
        assert_eq!(first.severity, DiagnosticSeverity::Error);
        assert!(first.message.contains("undefined_var"));
        assert_eq!(first.location.as_ref().unwrap().line, 42);
        assert_eq!(first.location.as_ref().unwrap().column, 15);
    }
    
    #[test]
    fn test_parse_rustc_text_error() {
        let stderr = r#"error[E0425]: cannot find value `undefined_var` in this scope
  --> src/main.rs:10:5
   |
10 |     undefined_var;
   |     ^^^^^^^^^^^^^ not found in this scope

warning: unused variable: `y`
  --> src/main.rs:15:9
   |
15 |     let y = 5;
   |         ^ help: if this is intentional, prefix it with an underscore: `_y`"#;
        
        let report = parse_text_errors(stderr, "main");
        assert!(report.error_count >= 1);
        
        let first = &report.diagnostics[0];
        assert_eq!(first.severity, DiagnosticSeverity::Error);
        assert!(first.code.as_ref().map(|c| c == "E0425").unwrap_or(false));
    }
    
    #[test]
    fn test_parse_gcc_json() {
        let json = r#"[{"kind": "error", "message": "test error", "locations": [{"caret": {"file": "test.cpp", "line": 10, "column": 5}}], "children": [], "fixits": []}]"#;
        
        let report = parse_gcc_json(json, "test");
        assert_eq!(report.error_count, 1);
        assert_eq!(report.diagnostics[0].message, "test error");
    }
    
    #[test]
    fn test_diagnostic_severity() {
        assert_eq!(DiagnosticSeverity::from_str("error"), DiagnosticSeverity::Error);
        assert_eq!(DiagnosticSeverity::from_str("fatal error"), DiagnosticSeverity::Error);
        assert_eq!(DiagnosticSeverity::from_str("warning"), DiagnosticSeverity::Warning);
        assert_eq!(DiagnosticSeverity::from_str("note"), DiagnosticSeverity::Note);
    }
}
